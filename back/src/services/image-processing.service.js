import sharp from "sharp";
import s3Repository from "../repository/s3.repository.js";

const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_JPEG_QUALITY = 80;

const PREVIEW_WIDTH = 1200;
const PREVIEW_JPEG_QUALITY = 75;

// L'asset watermark (PNG transparent) est chargé depuis WATERMARK_ASSET_PATH plutôt
// que codé en dur, pour pouvoir le remplacer sans toucher au code.
const WATERMARK_ASSET_PATH = process.env.WATERMARK_ASSET_PATH || "./assets/watermark-placeholder.png";
const WATERMARK_OPACITY = Number(process.env.WATERMARK_OPACITY || 0.6);
const WATERMARK_POSITION = process.env.WATERMARK_POSITION || "southeast";
const WATERMARK_MARGIN = Number(process.env.WATERMARK_MARGIN || 24);

const deriveDerivedKey = (key, suffix) => `${key.replace(/\.[^./]+$/, "")}-${suffix}.jpg`;

const buildThumbnail = (imageBuffer) =>
    sharp(imageBuffer)
        .resize({ width: THUMBNAIL_WIDTH })
        .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
        .toBuffer();

// Positionne le watermark dans un coin/le centre avec une marge, plutôt qu'en grille
// répétée, pour ne pas nuire à la lisibilité de la photo pendant la sélection client.
const computeCornerOffset = (position, containerWidth, containerHeight, overlayWidth, overlayHeight, margin) => {
    const anchors = {
        north: { left: (containerWidth - overlayWidth) / 2, top: margin },
        south: { left: (containerWidth - overlayWidth) / 2, top: containerHeight - overlayHeight - margin },
        east: { left: containerWidth - overlayWidth - margin, top: (containerHeight - overlayHeight) / 2 },
        west: { left: margin, top: (containerHeight - overlayHeight) / 2 },
        northeast: { left: containerWidth - overlayWidth - margin, top: margin },
        northwest: { left: margin, top: margin },
        southeast: { left: containerWidth - overlayWidth - margin, top: containerHeight - overlayHeight - margin },
        southwest: { left: margin, top: containerHeight - overlayHeight - margin },
        center: { left: (containerWidth - overlayWidth) / 2, top: (containerHeight - overlayHeight) / 2 }
    };
    const { left, top } = anchors[position] || anchors.southeast;
    return { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) };
};

// Réduit l'opacité du watermark en atténuant uniquement son canal alpha
// (les canaux couleur restent inchangés).
const applyOpacity = (buffer, opacity) =>
    sharp(buffer)
        .ensureAlpha()
        .linear([1, 1, 1, opacity], [0, 0, 0, 0])
        .toBuffer();

const buildPreview = async (imageBuffer, { watermark = true } = {}) => {
    const { data: resizedBuffer, info } = await sharp(imageBuffer)
        .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });

    if (!watermark) {
        return sharp(resizedBuffer)
            .jpeg({ quality: PREVIEW_JPEG_QUALITY })
            .toBuffer();
    }

    const watermarkBuffer = await applyOpacity(WATERMARK_ASSET_PATH, WATERMARK_OPACITY);
    const { width: watermarkWidth, height: watermarkHeight } = await sharp(watermarkBuffer).metadata();

    const { left, top } = computeCornerOffset(
        WATERMARK_POSITION, info.width, info.height, watermarkWidth, watermarkHeight, WATERMARK_MARGIN
    );

    return sharp(resizedBuffer)
        .composite([{ input: watermarkBuffer, left, top }])
        .jpeg({ quality: PREVIEW_JPEG_QUALITY })
        .toBuffer();
};

export const generateDerivedImages = async (key, { watermark = true } = {}) => {
    const original = await s3Repository.getObject(key);

    const [thumbnailBuffer, previewBuffer] = await Promise.all([
        buildThumbnail(original),
        buildPreview(original, { watermark })
    ]);

    const thumbnailKey = deriveDerivedKey(key, "thumb");
    const previewKey = deriveDerivedKey(key, "preview");

    await Promise.all([
        s3Repository.putObject(thumbnailKey, thumbnailBuffer, "image/jpeg"),
        s3Repository.putObject(previewKey, previewBuffer, "image/jpeg")
    ]);

    return { thumbnailKey, previewKey };
};
