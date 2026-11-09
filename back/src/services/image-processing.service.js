import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import s3Repository from "../repository/s3.repository.js";
import { validateWatermarkValues, loadSavedWatermarkValues, buildWatermarkConfig } from "./settings.service.js";
import { LIMITS } from "../config/limits.js";
import { getMemorySnapshot } from "../utils/memory.js";
import logger from "../logger.js";

const log = logger.child("image-processing");

// Process-wide libvips settings, applied when this module loads (every code path that can
// reach sharp imports it). cache(false): each original is processed once, caching its
// pixels only holds memory. concurrency: libvips threads per operation; on musl (the
// Alpine image) sharp's default is the host's core count, far above the container's CPU quota.
export const configureSharp = () => {
    sharp.cache(false);
    sharp.concurrency(LIMITS.sharpConcurrency);
    log.info("sharp configured", {
        sharp: sharp.versions.sharp,
        libvips: sharp.versions.vips,
        concurrency: sharp.concurrency(),
        cache: false,
        maxInputPixels: LIMITS.maxInputPixels
    });
};
configureSharp();

// failOn "warning" is sharp's default, spelled out so it is never loosened by accident: a
// truncated or damaged JPEG is refused instead of rendering a grey band. limitInputPixels
// makes the decompression-bomb ceiling explicit.
const INPUT_OPTIONS = Object.freeze({ failOn: "warning", limitInputPixels: LIMITS.maxInputPixels });

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

// Stage 1: the only decode of the original. Auto-orients from EXIF (sharp drops the tag
// on output, so a portrait shot would otherwise come out sideways), shrinks to the preview
// width and hands back raw pixels: no intermediate JPEG, hence no second lossy generation.
// toColourspace("srgb") guarantees 3 channels, so the raw pixels are never read back as the
// wrong layout (grayscale and CMYK JPEGs would otherwise yield 1 or 4 channels).
const resizeToRaw = (imageBuffer) =>
    sharp(imageBuffer, INPUT_OPTIONS)
        .autoOrient()
        .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
        .toColourspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });

// Stage 2: optional watermark, then the single JPEG encode of the preview.
const encodePreview = async ({ data, info }, { watermark = false } = {}) => {
    const startedAt = performance.now();
    const resized = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });

    if (!watermark) {
        log.debug("Building preview without watermark", { width: info.width, height: info.height });
        return resized()
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

    const preview = await resized()
        .composite([{ input: watermarkBuffer, left, top }])
        .jpeg({ quality: PREVIEW_JPEG_QUALITY })
        .toBuffer();
    log.debug("Preview built with watermark", {
        width: info.width, height: info.height, position: watermark.position, left, top, bytes: preview.length,
        durationMs: Math.round(performance.now() - startedAt)
    });
    return preview;
};

export const buildPreview = async (imageBuffer, { watermark = false } = {}) =>
    encodePreview(await resizeToRaw(imageBuffer), { watermark });

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
// `originalSize` is the size S3 reported (HEAD), used for logs so the original Buffer does
// not have to stay referenced until the end.
export const generateDerivedImages = async (key, { watermark = true, watermarkConfig: sharedWatermarkConfig, originalSize } = {}) => {
    const startedAt = performance.now();
    log.debug("Generating derived images", { key, watermark });
    const watermarkConfig = watermark
        ? (sharedWatermarkConfig ?? await buildWatermarkConfig(await loadSavedWatermarkValues()))
        : false;

    let original = await s3Repository.getObject(key);
    const originalBytes = originalSize ?? original.length;
    const resized = await resizeToRaw(original);
    original = null; // the only decode is done: the largest Buffer of the request can be collected

    const previewBuffer = await encodePreview(resized, { watermark: watermarkConfig });
    resized.data = null;
    const thumbnailBuffer = await buildThumbnail(previewBuffer);

    const thumbnailKey = deriveDerivedKey(key, "thumb");
    const previewKey = deriveDerivedKey(key, "preview");

    await Promise.all([
        s3Repository.putObject(thumbnailKey, thumbnailBuffer, "image/jpeg"),
        s3Repository.putObject(previewKey, previewBuffer, "image/jpeg")
    ]);

    log.info("Derived images generated", {
        key, thumbnailKey, previewKey, watermark,
        originalBytes, previewBytes: previewBuffer.length, thumbnailBytes: thumbnailBuffer.length,
        durationMs: Math.round(performance.now() - startedAt),
        ...getMemorySnapshot()
    });
    return { thumbnailKey, previewKey };
};
