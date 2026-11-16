import PQueue from "p-queue";
import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { generateDerivedImages } from "./image-processing.service.js";
import { completeSendIfReady, sweepSendRequests } from "./collection-send.service.js";
import logger from "../logger.js";

const log = logger.child("photo-worker");

const SWEEP_INTERVAL_MS = 60_000;

const readPositiveInt = (name, fallback) => {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const isWorkerEnabled = () => process.env.WORKER_ENABLED !== 'false';

const readConfig = () => ({
    concurrency: readPositiveInt('WORKER_CONCURRENCY', 2),
    pollIntervalMs: readPositiveInt('WORKER_POLL_INTERVAL_MS', 2000),
    maxAttempts: readPositiveInt('WORKER_MAX_ATTEMPTS', 3),
    stuckAfterMs: readPositiveInt('WORKER_STUCK_AFTER_MS', 300_000),
    retryDelayMs: readPositiveInt('WORKER_RETRY_DELAY_MS', 30_000)
});

// A single atomic statement, so a photo can never be claimed twice (even with several
// workers): the sub-select locks the row and SKIP LOCKED makes concurrent claimers move
// on to the next one. `processingAttempts` is incremented here, at claim time.
//
// Backoff: a photo that already failed (attempts > 0) is only claimable again once
// `attempts * retryDelayMs` have passed since its failure was recorded (`updatedAt`, set
// by markPhotoFailed). Without it, a short storage outage burns all the attempts of every
// queued photo within a second. A manual retry resets the attempts to 0, so it starts
// right away. Waiting photos are skipped, so the others keep flowing.
const CLAIM_NEXT_PHOTO_SQL = `
    UPDATE "Photos"
    SET "processingStatus" = 'PROCESSING',
        "processingStartedAt" = now(),
        "processingAttempts" = "processingAttempts" + 1
    WHERE id = (
        SELECT id FROM "Photos"
        WHERE "processingStatus" = 'QUEUED'
          AND ("processingAttempts" = 0
               OR "updatedAt" <= now() - ("processingAttempts" * :retryDelayMs * interval '1 millisecond'))
        ORDER BY "createdAt", id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
`;

export const claimNextPhoto = async ({ retryDelayMs }) => {
    const photos = await db.sequelize.query(CLAIM_NEXT_PHOTO_SQL, { model: db.Photo, mapToModel: true, replacements: { retryDelayMs } });
    return photos[0] ?? null;
};

const removeDerivedObjects = async (keys) => {
    await Promise.all(keys.filter(Boolean).map(async (key) => {
        try {
            await s3Repository.deleteObject(key);
        } catch (error) {
            log.error("Could not delete derived object of a photo deleted during processing (orphaned file)", error, { key });
        }
    }));
};

// The update is guarded on PROCESSING so a row that the stuck-photo sweep already put
// back in the queue (and another run may have claimed) is never overwritten by a slow run.
const markPhotoDone = async (photo, { thumbnailKey, previewKey }) => {
    const [updatedRows] = await db.Photo.update(
        { thumbnailKey, previewKey, processingStatus: 'DONE', processingError: null },
        { where: { id: photo.id, processingStatus: 'PROCESSING' } }
    );
    return updatedRows > 0;
};

// Retries until the attempts are exhausted, then FAILED. `processingAttempts` already
// counts the run that just failed (incremented when the photo was claimed).
export const markPhotoFailed = async (photo, error, maxAttempts) => {
    const exhausted = photo.processingAttempts >= maxAttempts;
    const [updatedRows] = await db.Photo.update(
        { processingStatus: exhausted ? 'FAILED' : 'QUEUED', processingError: String(error?.message ?? error).slice(0, 2000) },
        { where: { id: photo.id, processingStatus: 'PROCESSING' } }
    );
    return { updatedRows, exhausted };
};

export const processPhoto = async (photo, { maxAttempts }) => {
    const startedAt = performance.now();
    let derived = null;
    try {
        log.debug("Processing photo", { photoId: photo.id, collectionId: photo.collectionId, attempt: photo.processingAttempts });
        // Delivered photos are the final files: no watermark. The watermark settings are
        // read inside generateDerivedImages, i.e. at processing time.
        derived = await generateDerivedImages(photo.key, { watermark: photo.status !== 'DELIVERED' });
        const updated = await markPhotoDone(photo, derived);
        if (!updated) {
            // Photo deleted while it was processed (or put back in the queue by the
            // stuck sweep): the derivatives just uploaded belong to nobody.
            const stillExists = await db.Photo.count({ where: { id: photo.id } });
            if (!stillExists) {
                log.info("Photo deleted during processing, removing its derived images", { photoId: photo.id, collectionId: photo.collectionId });
                await removeDerivedObjects([derived.thumbnailKey, derived.previewKey]);
            } else {
                log.warn("Photo no longer PROCESSING when the run finished, result not recorded", { photoId: photo.id });
            }
            return;
        }
        log.info("Photo processed", { photoId: photo.id, collectionId: photo.collectionId, durationMs: Math.round(performance.now() - startedAt) });
        // The photographer may be waiting for this collection's last photo to send the link.
        // completeSendIfReady never throws: a failure here must not mark the photo as failed.
        await completeSendIfReady(photo.collectionId);
    } catch (error) {
        const { updatedRows, exhausted } = await markPhotoFailed(photo, error, maxAttempts).catch((updateError) => {
            log.failure("Could not record the processing failure", updateError, { photoId: photo.id });
            return { updatedRows: 0, exhausted: false };
        });
        if (updatedRows === 0) {
            // Photo deleted during processing: the error is expected, nothing to retry.
            log.info("Photo deleted during processing, error ignored", { photoId: photo.id, collectionId: photo.collectionId, error: error.message });
            await removeDerivedObjects([derived?.thumbnailKey, derived?.previewKey]);
            return;
        }
        if (exhausted) {
            log.failure("Photo processing failed, no attempt left", error, { photoId: photo.id, collectionId: photo.collectionId, attempts: photo.processingAttempts });
        } else {
            log.warn("Photo processing failed, it will be retried", { photoId: photo.id, collectionId: photo.collectionId, attempt: photo.processingAttempts, maxAttempts, error: error.message });
        }
    }
};

// Photos stuck in PROCESSING (restart or deploy in the middle of a run) go back to the
// queue, or to FAILED when their attempts are used up.
export const recoverStuckPhotos = async ({ stuckAfterMs, maxAttempts }) => {
    const [, result] = await db.sequelize.query(
        `UPDATE "Photos"
         SET "processingStatus" = CASE WHEN "processingAttempts" >= :maxAttempts
                                       THEN 'FAILED'::"enum_Photos_processingStatus"
                                       ELSE 'QUEUED'::"enum_Photos_processingStatus" END,
             "processingError" = 'Processing interrupted (worker stopped or timed out)'
         WHERE "processingStatus" = 'PROCESSING'
           AND "processingStartedAt" < now() - (:stuckAfterMs * interval '1 millisecond')`,
        { replacements: { maxAttempts, stuckAfterMs } }
    );
    const recovered = result?.rowCount ?? 0;
    if (recovered > 0) {
        log.warn("Stuck photos recovered", { count: recovered, stuckAfterMs });
    }
    return recovered;
};

let activeWorker = null;

// Wakes the loop right away (used after a confirm); a no-op when the worker is not
// running in this process, the poll interval then picks the photos up.
export const wakeWorker = () => activeWorker?.wake();

export const startWorker = () => {
    if (activeWorker) {
        return activeWorker;
    }
    const config = readConfig();
    const queue = new PQueue({ concurrency: config.concurrency });
    let stopping = false;
    let wakePending = false;
    let wakeSleeper = null;
    let sweepTimer = null;

    const wake = () => {
        wakePending = true;
        wakeSleeper?.();
    };

    const sleep = (ms) => new Promise((resolve) => {
        if (wakePending) {
            wakePending = false;
            return resolve();
        }
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            wakeSleeper = null;
            wakePending = false;
            resolve();
        }
        wakeSleeper = done;
    });

    const hasCapacity = () => queue.pending + queue.size < config.concurrency;

    const sweep = async () => {
        try {
            await recoverStuckPhotos(config);
            await sweepSendRequests();
        } catch (error) {
            log.failure("Stuck photos sweep failed", error);
        }
    };

    const runLoop = async () => {
        await sweep();
        while (!stopping) {
            try {
                while (!stopping && hasCapacity()) {
                    const photo = await claimNextPhoto(config);
                    if (!photo) break;
                    queue.add(async () => {
                        await processPhoto(photo, config);
                        wake();
                    }).catch((error) => log.failure("Unexpected worker task error", error, { photoId: photo.id }));
                }
            } catch (error) {
                log.failure("Could not read the processing queue", error);
            }
            await sleep(config.pollIntervalMs);
        }
    };

    log.info("Photo worker started", config);
    const loopPromise = runLoop();
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    const stop = async () => {
        if (stopping) return loopPromise;
        log.info("Photo worker stopping: no new photo taken, waiting for the ones in progress", { inProgress: queue.pending });
        stopping = true;
        clearInterval(sweepTimer);
        wake();
        await loopPromise;
        await queue.onIdle();
        activeWorker = null;
        log.info("Photo worker stopped");
    };

    activeWorker = { wake, stop };
    return activeWorker;
};

export const stopWorker = async () => {
    await activeWorker?.stop();
};
