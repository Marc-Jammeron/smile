// Operational limits, all overridable through environment variables. An invalid or
// out-of-range value never crashes the boot: it falls back to the safe default.
const parseBoundedInt = (raw, fallback, { min, max }) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return fallback;
    }
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

export const readLimits = (env = process.env) => ({
    // Request shape (HTTP 400 beyond these).
    maxConfirmPhotos: parseBoundedInt(env.CONFIRM_MAX_PHOTOS, 10, { min: 1, max: 100 }),
    maxConfirmAttachments: parseBoundedInt(env.CONFIRM_MAX_ATTACHMENTS, 50, { min: 1, max: 500 }),
    maxPresignFiles: parseBoundedInt(env.PRESIGN_MAX_FILES, 50, { min: 1, max: 500 }),

    // Image processing. 2 photos at once overlaps S3 I/O with CPU work; on 0.25 vCPU the
    // work itself is CPU-bound, so going higher mostly multiplies memory.
    imageProcessingConcurrency: parseBoundedInt(env.IMAGE_PROCESSING_CONCURRENCY, 2, { min: 1, max: 8 }),
    // libvips threads. 1 matches 250 mVCPU; more threads only add per-thread buffers.
    sharpConcurrency: parseBoundedInt(env.SHARP_CONCURRENCY, 1, { min: 1, max: 8 }),
    // Refuses before downloading: an original is held entirely in memory while decoded.
    maxOriginalBytes: parseBoundedInt(env.MAX_ORIGINAL_BYTES, 150_000_000, { min: 1_000_000, max: 2_000_000_000 }),
    // ~150 Mpx covers medium format (100 Mpx); sharp's own default is ~268 Mpx.
    maxInputPixels: parseBoundedInt(env.MAX_INPUT_PIXELS, 150_000_000, { min: 1_000_000, max: 1_000_000_000 })
});

export const LIMITS = Object.freeze(readLimits());
