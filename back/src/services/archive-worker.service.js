import archiver from "archiver";
import PQueue from "p-queue";
import { PassThrough } from "node:stream";
import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { buildArchivePlan, buildArchiveS3Key, deleteArchive } from "./collection-archive.service.js";
import logger from "../logger.js";

const log = logger.child("archive-worker");

const readPositiveInt = (name, fallback) => {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const isArchiveWorkerEnabled = () => process.env.WORKER_ARCHIVE_ENABLED !== 'false';

// maxAttempts, retryDelayMs and pollIntervalMs are shared with the photo worker.
export const readArchiveConfig = () => ({
    concurrency: readPositiveInt('WORKER_ARCHIVE_CONCURRENCY', 1),
    pollIntervalMs: readPositiveInt('WORKER_POLL_INTERVAL_MS', 2000),
    maxAttempts: readPositiveInt('WORKER_MAX_ATTEMPTS', 3),
    retryDelayMs: readPositiveInt('WORKER_RETRY_DELAY_MS', 30_000),
    partSizeBytes: readPositiveInt('ARCHIVE_PART_SIZE_MB', 16) * 1024 * 1024,
    stuckAfterMs: readPositiveInt('ARCHIVE_STUCK_AFTER_MS', 120_000),
    heartbeatIntervalMs: 10_000
});

// The worker is shutting down: the build is dropped and the archive goes back in the queue.
export class ArchiveInterruptedError extends Error {
    constructor() {
        super('Archive build interrupted by a shutdown');
        this.name = 'ArchiveInterruptedError';
    }
}

// The row is no longer ours (deleted, or put back in the queue by the stuck sweep).
export class ArchiveLostError extends Error {
    constructor() {
        super('Archive is no longer being processed by this run');
        this.name = 'ArchiveLostError';
    }
}

// --- claiming ---------------------------------------------------------------------------

// Same atomic statement as the photo queue (see photo-worker.service.js): the sub-select
// locks the row and SKIP LOCKED makes concurrent claimers move on. `attempts` is incremented
// here, at claim time. An archive that already failed waits `attempts x retryDelayMs` after
// the failure (`updatedAt`, bumped by markArchiveFailed) before it is claimed again.
// "updatedAt" is set by hand: raw SQL does not go through Sequelize's timestamps.
const CLAIM_NEXT_ARCHIVE_SQL = `
    UPDATE "CollectionArchives"
    SET "status" = 'PROCESSING',
        "startedAt" = now(),
        "heartbeatAt" = now(),
        "attempts" = "attempts" + 1,
        "updatedAt" = now()
    WHERE id = (
        SELECT id FROM "CollectionArchives"
        WHERE "status" = 'QUEUED'
          AND ("attempts" = 0
               OR "updatedAt" <= now() - ("attempts" * :retryDelayMs * interval '1 millisecond'))
        ORDER BY "createdAt", id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
`;

export const claimNextArchive = async ({ retryDelayMs }) => {
    const archives = await db.sequelize.query(CLAIM_NEXT_ARCHIVE_SQL, { model: db.CollectionArchive, mapToModel: true, replacements: { retryDelayMs } });
    return archives[0] ?? null;
};

// --- recording the outcome ----------------------------------------------------------------

// Every update below is guarded on PROCESSING, so a row that the sweep put back in the queue
// (or that was deleted) is never overwritten by a slow or stale run.
const updateIfProcessing = async (id, values, extraWhere = {}) => {
    const [updatedRows] = await db.CollectionArchive.update(values, { where: { id, status: 'PROCESSING', ...extraWhere } });
    return updatedRows > 0;
};

// Heartbeat: the stuck threshold is measured on it, not on the total duration, so a long ZIP
// that keeps moving is never considered stuck. False when the row is no longer ours.
const touchHeartbeat = (id) => updateIfProcessing(id, { heartbeatAt: new Date() });

// Retries until the attempts are exhausted, then FAILED. `attempts` already counts the run
// that just failed (incremented when the archive was claimed).
export const markArchiveFailed = async (archive, error, maxAttempts) => {
    const exhausted = archive.attempts >= maxAttempts;
    const updated = await updateIfProcessing(archive.id, {
        status: exhausted ? 'FAILED' : 'QUEUED',
        error: String(error?.message ?? error).slice(0, 2000),
        heartbeatAt: null
    });
    return { updated, exhausted };
};

// Shutdown: back in the queue without using up an attempt (the claim had counted one).
const releaseArchive = async (archive) => {
    const [, result] = await db.sequelize.query(
        `UPDATE "CollectionArchives"
         SET "status" = 'QUEUED', "attempts" = GREATEST("attempts" - 1, 0), "heartbeatAt" = NULL, "updatedAt" = now()
         WHERE id = :id AND "status" = 'PROCESSING'`,
        { replacements: { id: archive.id } }
    );
    return (result?.rowCount ?? 0) > 0;
};

const deleteStoredFile = async (key) => {
    try {
        await s3Repository.deleteObject(key);
    } catch (error) {
        log.error("Could not delete an archive file from storage (orphaned file)", error, { key });
    }
};

// Longest the cleanup of a failed multipart upload is waited for.
const UPLOAD_ABORT_WAIT_MS = 10_000;

// --- building the ZIP ---------------------------------------------------------------------

// JPEG and CR2 are already compressed: `store` keeps the CPU out of the way (the build is
// limited by the network, not by the processor). Nothing touches the disk and memory stays
// around partSize x queueSize.
//
// One S3 read is open at a time. archiver's `append` only queues the entry, so each entry
// is waited for (the `entry` event) before the next object is opened: without that, every
// object of the collection would be opened at once and sit idle on its socket.
//
// Any failure (a missing file, an S3 error, a broken stream, a lost row, a shutdown) aborts
// the whole build: the multipart upload is aborted so no part is left behind, and nothing
// is ever published.
const buildZip = async (archive, entries, s3Key, config, signal) => {
    const zip = archiver('zip', { store: true });
    const body = new PassThrough();
    // A destroyed body emits 'error'; without a listener that would be an uncaught exception
    // that takes the whole process down. The failure is already reported through
    // `upload.done()` and `buildFailed`.
    body.on('error', () => {});
    zip.pipe(body);

    const upload = s3Repository.createStreamUpload(s3Key, body, {
        contentType: 'application/zip',
        partSizeBytes: config.partSizeBytes,
        queueSize: 2
    });

    let failBuild;
    const buildFailed = new Promise((_, reject) => { failBuild = reject; });
    buildFailed.catch(() => {}); // only observed through the races below

    zip.on('error', failBuild);
    zip.on('warning', (warning) => log.warn("Archiver warning", { archiveId: archive.id, error: warning.message }));

    const onAbort = () => failBuild(new ArchiveInterruptedError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const uploadDone = upload.done();
    uploadDone.catch(failBuild);

    // Covers the time spent inside one big file: the beat only goes out while bytes keep
    // flowing, so a stream that hangs stops beating and the sweep recovers the job.
    let lastPointer = 0;
    const heartbeatTimer = setInterval(async () => {
        const pointer = zip.pointer();
        if (pointer === lastPointer) return;
        lastPointer = pointer;
        try {
            if (!await touchHeartbeat(archive.id)) failBuild(new ArchiveLostError());
        } catch (error) {
            log.warn("Could not record the heartbeat", { archiveId: archive.id, error: error.message });
        }
    }, config.heartbeatIntervalMs);

    let currentSource = null;
    try {
        for (const entry of entries) {
            const source = await Promise.race([s3Repository.getObjectStream(entry.key), buildFailed]);
            currentSource = source;
            source.once('error', failBuild);
            const entryDone = new Promise((resolve) => zip.once('entry', resolve));
            zip.append(source, { name: entry.name });
            await Promise.race([entryDone, buildFailed]);
            currentSource = null;
            if (!await touchHeartbeat(archive.id)) {
                throw new ArchiveLostError();
            }
        }
        await Promise.race([zip.finalize(), buildFailed]);
        await Promise.race([uploadDone, buildFailed]);
        return { sizeBytes: zip.pointer() };
    } catch (error) {
        zip.abort();
        currentSource?.destroy();
        // Ending the body with an error makes lib-storage abort the multipart upload itself, and
        // its `done()` only rejects once the AbortMultipartUpload request has completed: that is
        // what is waited for. Calling `upload.abort()` first would reject `done()` at once and
        // leave the request running in the background, which a SIGTERM can cut short (parts
        // left behind, billed until the bucket's lifecycle rule drops them).
        body.destroy(error);
        await Promise.race([
            uploadDone.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, UPLOAD_ABORT_WAIT_MS).unref())
        ]);
        // Safety net, in case the upload did not notice (a no-op once it has settled).
        await upload.abort().catch((abortError) => log.warn("Could not abort the multipart upload", { archiveId: archive.id, error: abortError.message }));
        throw error;
    } finally {
        clearInterval(heartbeatTimer);
        signal?.removeEventListener('abort', onAbort);
    }
};

// --- one job --------------------------------------------------------------------------------

// The content changed while the ZIP was being built (an attachment was added or removed):
// the ZIP just built is discarded and the archive goes for another pass. Not a failure, so
// the attempts start over. `fingerprint` is only written when we know the new target; when
// ensureArchive already moved it, the next pass finds it there.
const requeueAfterChange = async (archive, previousKey, newKey, fingerprint) => {
    const values = { status: 'QUEUED', attempts: 0, error: null, startedAt: null, heartbeatAt: null };
    if (fingerprint) values.fingerprint = fingerprint;
    await updateIfProcessing(archive.id, values);
    if (newKey !== previousKey) {
        await deleteStoredFile(newKey);
    }
};

// `previousKey` is the ZIP stored before this build (null for the first one).
const finishArchive = async (archive, previousKey, plan, newKey, sizeBytes) => {
    // End check: what we built must still be what the collection holds. This also covers a
    // trigger that was missed (nobody called ensureArchive).
    const current = await buildArchivePlan(archive.collectionId, archive.kind);
    if (current.fingerprint !== plan.fingerprint) {
        log.info("Content changed during the build, another pass is needed", { archiveId: archive.id, collectionId: archive.collectionId, kind: archive.kind });
        await requeueAfterChange(archive, previousKey, newKey, current.entries.length > 0 ? current.fingerprint : null);
        return false;
    }

    // `fingerprint` in the guard: an ensureArchive that moved the target since the start of
    // the build makes this update match nothing.
    const recorded = await updateIfProcessing(archive.id, {
        status: 'DONE',
        s3Key: newKey,
        builtFingerprint: plan.fingerprint,
        sizeBytes,
        photoCount: new Set(plan.entries.map(({ photoId }) => photoId)).size,
        attempts: 0,
        error: null,
        heartbeatAt: null
    }, { fingerprint: plan.fingerprint });

    if (recorded) {
        // The previous ZIP is only removed now that the new one is DONE. Same key = same content.
        if (previousKey && previousKey !== newKey) {
            await deleteStoredFile(previousKey);
        }
        return true;
    }

    const stillThere = await db.CollectionArchive.findOne({ where: { id: archive.id } });
    if (!stillThere) {
        // The archive (or its collection) was deleted during the build: the file just
        // uploaded belongs to nobody.
        log.info("Archive deleted during its build, removing the uploaded file", { archiveId: archive.id, collectionId: archive.collectionId });
        await deleteStoredFile(newKey);
    } else if (stillThere.status === 'PROCESSING') {
        log.info("Target moved during the build, another pass is needed", { archiveId: archive.id, collectionId: archive.collectionId, kind: archive.kind });
        await requeueAfterChange(archive, previousKey, newKey, null);
    } else {
        log.warn("Archive no longer PROCESSING when the build finished, result not recorded", { archiveId: archive.id, status: stillThere.status });
    }
    return false;
};

export const processArchive = async (archive, config, { signal } = {}) => {
    const startedAt = performance.now();
    const { id, collectionId, kind } = archive;
    const previousKey = archive.s3Key;
    let newKey = null;
    let uploaded = false;
    try {
        log.debug("Building archive", { archiveId: id, collectionId, kind, attempt: archive.attempts });
        const plan = await buildArchivePlan(collectionId, kind);
        if (plan.entries.length === 0) {
            log.info("Nothing left to archive, removing the archive", { archiveId: id, collectionId, kind });
            await deleteArchive(collectionId, kind);
            return;
        }

        // The target is brought in line with what is about to be built (a trigger may not have
        // run yet): the end check compares against it.
        if (!await updateIfProcessing(id, { fingerprint: plan.fingerprint })) {
            throw new ArchiveLostError();
        }

        newKey = buildArchiveS3Key(collectionId, kind, plan.fingerprint);
        const { sizeBytes } = await buildZip(archive, plan.entries, newKey, config, signal);
        uploaded = true;

        const published = await finishArchive(archive, previousKey, plan, newKey, sizeBytes);
        if (published) {
            log.info("Archive built", { archiveId: id, collectionId, kind, fileCount: plan.entries.length, sizeBytes, durationMs: Math.round(performance.now() - startedAt) });
        }
    } catch (error) {
        if (error instanceof ArchiveLostError) {
            log.info("Archive build abandoned: the row is no longer ours", { archiveId: id, collectionId, kind });
            return;
        }
        if (error instanceof ArchiveInterruptedError) {
            await releaseArchive(archive).catch((releaseError) => log.failure("Could not put the interrupted archive back in the queue", releaseError, { archiveId: id }));
            log.info("Archive build interrupted by the shutdown, it will start over", { archiveId: id, collectionId, kind });
            return;
        }
        // The upload finished but recording it failed: the file is not referenced by anything.
        if (uploaded && newKey !== previousKey) {
            await deleteStoredFile(newKey);
        }
        const { updated, exhausted } = await markArchiveFailed(archive, error, config.maxAttempts).catch((updateError) => {
            log.failure("Could not record the archive failure", updateError, { archiveId: id });
            return { updated: false, exhausted: false };
        });
        if (!updated) {
            log.info("Archive no longer PROCESSING, error ignored", { archiveId: id, collectionId, kind, error: error.message });
        } else if (exhausted) {
            log.failure("Archive build failed, no attempt left", error, { archiveId: id, collectionId, kind, attempts: archive.attempts });
        } else {
            log.warn("Archive build failed, it will be retried", { archiveId: id, collectionId, kind, attempt: archive.attempts, maxAttempts: config.maxAttempts, error: error.message });
        }
    }
};

// --- sweep ------------------------------------------------------------------------------------

// PROCESSING archives without a heartbeat for `stuckAfterMs` (restart, crash, hung stream)
// go back to the queue, or to FAILED when their attempts are used up. `heartbeatAt`, not
// `startedAt`: a build that keeps moving is never stuck, however long it lasts.
export const recoverStuckArchives = async ({ stuckAfterMs, maxAttempts }) => {
    const [, result] = await db.sequelize.query(
        `UPDATE "CollectionArchives"
         SET "status" = CASE WHEN "attempts" >= :maxAttempts
                             THEN 'FAILED'::"enum_CollectionArchives_status"
                             ELSE 'QUEUED'::"enum_CollectionArchives_status" END,
             "error" = 'Build interrupted (worker stopped, or no progress)',
             "updatedAt" = now()
         WHERE "status" = 'PROCESSING'
           AND COALESCE("heartbeatAt", "startedAt") < now() - (:stuckAfterMs * interval '1 millisecond')`,
        { replacements: { maxAttempts, stuckAfterMs } }
    );
    const recovered = result?.rowCount ?? 0;
    if (recovered > 0) {
        log.warn("Stuck archives recovered", { count: recovered, stuckAfterMs });
    }
    return recovered;
};

// --- the loop ---------------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;

let activeWorker = null;

// Wakes the loop right away (used after an archive was queued); a no-op when the worker is
// not running in this process, the poll interval then picks the archive up.
export const wakeArchiveWorker = () => activeWorker?.wake();

// Same loop as the photo worker, in the same process, on its own queue: a big ZIP never
// delays the thumbnails.
export const startArchiveWorker = () => {
    if (activeWorker) {
        return activeWorker;
    }
    const config = readArchiveConfig();
    const queue = new PQueue({ concurrency: config.concurrency });
    const shutdown = new AbortController();
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
            await recoverStuckArchives(config);
        } catch (error) {
            log.failure("Stuck archives sweep failed", error);
        }
    };

    const runLoop = async () => {
        await sweep();
        while (!stopping) {
            try {
                while (!stopping && hasCapacity()) {
                    const archive = await claimNextArchive(config);
                    if (!archive) break;
                    queue.add(async () => {
                        await processArchive(archive, config, { signal: shutdown.signal });
                        wake();
                    }).catch((error) => log.failure("Unexpected archive worker task error", error, { archiveId: archive.id }));
                }
            } catch (error) {
                log.failure("Could not read the archive queue", error);
            }
            await sleep(config.pollIntervalMs);
        }
    };

    log.info("Archive worker started", { ...config, partSizeMb: config.partSizeBytes / 1024 / 1024 });
    const loopPromise = runLoop();
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    // Unlike photos, a ZIP in progress is not waited for (it can last minutes, a deploy
    // must not): the build is dropped, its multipart upload aborted, and the archive goes
    // back in the queue to start over on the next boot.
    const stop = async () => {
        if (stopping) return loopPromise;
        log.info("Archive worker stopping: no new archive taken, interrupting the ones in progress", { inProgress: queue.pending });
        stopping = true;
        clearInterval(sweepTimer);
        shutdown.abort();
        wake();
        await loopPromise;
        await queue.onIdle();
        activeWorker = null;
        log.info("Archive worker stopped");
    };

    activeWorker = { wake, stop };
    return activeWorker;
};

export const stopArchiveWorker = async () => {
    await activeWorker?.stop();
};
