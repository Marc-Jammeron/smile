import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import s3Repository from "../repository/s3.repository.js";
import { validateWatermarkValues, loadSavedWatermarkValues, buildWatermarkConfig } from "./settings.service.js";
import { getMemorySnapshot } from "../utils/memory.js";
import logger from "../logger.js";

const log = logger.child("image-processing");

const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_JPEG_QUALITY = 80;

const PREVIEW_WIDTH = 1200;
const PREVIEW_JPEG_QUALITY = 75;

const WATERMARK_TEST_PHOTO_PATH = fileURLToPath(new URL("../../assets/watermark-test-photo.jpg", import.meta.url));

const deriveDerivedKey = (key, suffix) => `${key.replace(/\.[^./]+$/, "")}-${suffix}.jpg`;

const buildThumbnail = (previewBuffer) =>
    sharp(previewBuffer)
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

const applyOpacity = async (input, opacity) => {
    const rgba = await sharp(input)
        .toColourspace("srgb")
        .ensureAlpha()
        .png()
        .toBuffer();
    return sharp(rgba)
        .linear([1, 1, 1, opacity], [0, 0, 0, 0])
        .toBuffer();
};

export const buildPreview = async (imageBuffer, { watermark = false } = {}) => {
    const startedAt = performance.now();
    const { data: resizedBuffer, info } = await sharp(imageBuffer)
        .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });

    if (!watermark) {
        log.debug("Building preview without watermark", { width: info.width, height: info.height });
        return sharp(resizedBuffer)
            .jpeg({ quality: PREVIEW_JPEG_QUALITY })
            .toBuffer();
    }

    let watermarkInput = watermark.image;
    if (watermark.size != null) {
        const targetWidth = Math.max(1, Math.round(info.width * watermark.size / 100));
        watermarkInput = await sharp(watermarkInput).resize({ width: targetWidth }).toBuffer();
    }

    let watermarkBuffer = await applyOpacity(watermarkInput, watermark.opacity);
    let { width: watermarkWidth, height: watermarkHeight } = await sharp(watermarkBuffer).metadata();

    if (watermarkWidth > info.width || watermarkHeight > info.height) {
        log.debug("Watermark larger than the photo, shrinking it", { watermarkWidth, watermarkHeight, photoWidth: info.width, photoHeight: info.height });
        const shrunk = await sharp(watermarkBuffer)
            .resize({ width: info.width, height: info.height, fit: "inside" })
            .toBuffer({ resolveWithObject: true });
        watermarkBuffer = shrunk.data;
        watermarkWidth = shrunk.info.width;
        watermarkHeight = shrunk.info.height;
    }

    const { left, top } = computeCornerOffset(
        watermark.position, info.width, info.height, watermarkWidth, watermarkHeight, watermark.margin
    );

    const preview = await sharp(resizedBuffer)
        .composite([{ input: watermarkBuffer, left, top }])
        .jpeg({ quality: PREVIEW_JPEG_QUALITY })
        .toBuffer();
    log.debug("Preview built with watermark", {
        width: info.width, height: info.height, position: watermark.position, left, top, bytes: preview.length,
        durationMs: Math.round(performance.now() - startedAt)
    });
    return preview;
};

let testPhotoBuffer = null;

const loadTestPhoto = async () => {
    if (!testPhotoBuffer) {
        log.debug("Loading the watermark test photo", { path: WATERMARK_TEST_PHOTO_PATH });
        testPhotoBuffer = await readFile(WATERMARK_TEST_PHOTO_PATH);
    }
    return testPhotoBuffer;
};

export const generateWatermarkSample = async (values) => {
    const validated = await validateWatermarkValues(values ?? {});
    const config = await buildWatermarkConfig({
        watermarkKey: null,
        watermarkText: null,
        watermarkPosition: null,
        watermarkOpacity: null,
        watermarkSize: null,
        ...validated
    });
    return buildPreview(await loadTestPhoto(), { watermark: config });
};

// `watermarkConfig` lets a caller that processes several photos resolve the watermark once
// and share it; without it the saved settings are loaded here, as before.
export const generateDerivedImages = async (key, { watermark = true, watermarkConfig: sharedWatermarkConfig } = {}) => {
    const startedAt = performance.now();
    log.debug("Generating derived images", { key, watermark });
    const original = await s3Repository.getObject(key);
    const watermarkConfig = watermark
        ? (sharedWatermarkConfig ?? await buildWatermarkConfig(await loadSavedWatermarkValues()))
        : false;

    const previewBuffer = await buildPreview(original, { watermark: watermarkConfig });
    const thumbnailBuffer = await buildThumbnail(previewBuffer);

    const thumbnailKey = deriveDerivedKey(key, "thumb");
    const previewKey = deriveDerivedKey(key, "preview");

    await Promise.all([
        s3Repository.putObject(thumbnailKey, thumbnailBuffer, "image/jpeg"),
        s3Repository.putObject(previewKey, previewBuffer, "image/jpeg")
    ]);

    log.info("Derived images generated", {
        key, thumbnailKey, previewKey, watermark,
        originalBytes: original.length, previewBytes: previewBuffer.length, thumbnailBytes: thumbnailBuffer.length,
        durationMs: Math.round(performance.now() - startedAt),
        ...getMemorySnapshot()
    });
    return { thumbnailKey, previewKey };
};
