import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import s3Repository from "../repository/s3.repository.js";
import { validateWatermarkValues, loadSavedWatermarkValues, buildWatermarkConfig } from "./settings.service.js";
import logger from "../logger.js";
import { timed, roundTimings, startCpuTimer, trackJob, takeEventLoopLagP99Ms } from "./runtime-metrics.js";

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

// `timings`, when given, receives the duration (ms) of each stage: `decodeResizeMs`,
// `watermarkMs` (watermark resize + opacity + metadata) and `composeEncodeMs` (composite
// and JPEG encoding are one sharp pipeline, so they are timed together).
export const buildPreview = async (imageBuffer, { watermark = false, timings = null } = {}) => {
    const startedAt = performance.now();
    // autoOrient first: phones and cameras store portrait photos as landscape pixels plus
    // an EXIF Orientation tag, which the derived JPEGs (written without metadata) lose.
    // Rotating before the resize also makes `width: 1200` apply to the displayed width.
    const { data: resizedBuffer, info } = await timed(timings, "decodeResizeMs", () => sharp(imageBuffer)
        .autoOrient()
        .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true }));

    if (!watermark) {
        log.debug("Building preview without watermark", { width: info.width, height: info.height });
        return timed(timings, "composeEncodeMs", () => sharp(resizedBuffer)
            .jpeg({ quality: PREVIEW_JPEG_QUALITY })
            .toBuffer());
    }

    const { watermarkBuffer, watermarkWidth, watermarkHeight } = await timed(timings, "watermarkMs", async () => {
        let watermarkInput = watermark.image;
        if (watermark.size != null) {
            const targetWidth = Math.max(1, Math.round(info.width * watermark.size / 100));
            watermarkInput = await sharp(watermarkInput).resize({ width: targetWidth }).toBuffer();
        }

        let buffer = await applyOpacity(watermarkInput, watermark.opacity);
        let { width, height } = await sharp(buffer).metadata();

        if (width > info.width || height > info.height) {
            log.debug("Watermark larger than the photo, shrinking it", { watermarkWidth: width, watermarkHeight: height, photoWidth: info.width, photoHeight: info.height });
            const shrunk = await sharp(buffer)
                .resize({ width: info.width, height: info.height, fit: "inside" })
                .toBuffer({ resolveWithObject: true });
            buffer = shrunk.data;
            width = shrunk.info.width;
            height = shrunk.info.height;
        }
        return { watermarkBuffer: buffer, watermarkWidth: width, watermarkHeight: height };
    });

    const { left, top } = computeCornerOffset(
        watermark.position, info.width, info.height, watermarkWidth, watermarkHeight, watermark.margin
    );

    const preview = await timed(timings, "composeEncodeMs", () => sharp(resizedBuffer)
        .composite([{ input: watermarkBuffer, left, top }])
        .jpeg({ quality: PREVIEW_JPEG_QUALITY })
        .toBuffer());
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

// One info line per photo with the time of every stage, to see where the time goes:
// `timings` (wall time, ms; the S3 stages include the network), `cpuUserMs`/`cpuSystemMs`
// (process-wide, see runtime-metrics.js), `eventLoopLagP99Ms` and `concurrentJobs`.
// `durationMs` covers everything below, S3 transfers included.
export const generateDerivedImages = async (key, { watermark = true } = {}) => {
    const startedAt = performance.now();
    const readCpu = startCpuTimer();
    const finishJob = trackJob();
    const timings = {};
    try {
        log.debug("Generating derived images", { key, watermark });

        const original = await timed(timings, "s3GetMs", () => s3Repository.getObject(key));
        let watermarkConfig = false;
        if (watermark) {
            const savedValues = await timed(timings, "settingsMs", () => loadSavedWatermarkValues());
            watermarkConfig = await timed(timings, "watermarkPrepMs", () => buildWatermarkConfig(savedValues));
        }

        const previewBuffer = await buildPreview(original, { watermark: watermarkConfig, timings });
        const thumbnailBuffer = await timed(timings, "thumbnailMs", () => buildThumbnail(previewBuffer));

        const thumbnailKey = deriveDerivedKey(key, "thumb");
        const previewKey = deriveDerivedKey(key, "preview");

        await timed(timings, "s3PutMs", () => Promise.all([
            s3Repository.putObject(thumbnailKey, thumbnailBuffer, "image/jpeg"),
            s3Repository.putObject(previewKey, previewBuffer, "image/jpeg")
        ]));

        const concurrentJobs = finishJob();
        log.info("Derived images generated", {
            key, thumbnailKey, previewKey, watermark,
            originalBytes: original.length, previewBytes: previewBuffer.length, thumbnailBytes: thumbnailBuffer.length,
            durationMs: Math.round(performance.now() - startedAt),
            timings: roundTimings(timings),
            ...readCpu(),
            eventLoopLagP99Ms: takeEventLoopLagP99Ms(),
            concurrentJobs
        });
        return { thumbnailKey, previewKey };
    } finally {
        // Also on failure, or the job would be counted as running forever.
        finishJob();
    }
};
