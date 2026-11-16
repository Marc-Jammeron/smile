import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// photo-worker.service.js imports db.repository.js (real Postgres connection as a module
// side effect), s3, the sharp pipeline and the send-request service: everything is mocked
// before import, same approach as the other service tests. The claim query itself is raw
// SQL that only Postgres can run, so its tests assert on the statement (ordering, locking,
// backoff) rather than on its execution.
let sqlCalls = [];
let queuedPhotos = [];
let sweepRowCount = 0;
let photoUpdateCalls = [];
let currentUpdatedRows = 1;
let photoStillExists = 1;
let deletedS3Keys = [];
let generateCalls = [];
let generateImpl = async (key) => ({ thumbnailKey: `${key}-thumb.jpg`, previewKey: `${key}-preview.jpg` });
let completeSendCalls = [];
let sweepSendRequestsCalls = 0;

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Photo: {
            update: async (data, options) => {
                photoUpdateCalls.push({ data, options });
                return [currentUpdatedRows];
            },
            count: async () => photoStillExists,
        },
        sequelize: {
            query: async (sql, options) => {
                sqlCalls.push({ sql, options });
                if (sql.includes('SKIP LOCKED')) {
                    return queuedPhotos.length > 0 ? [queuedPhotos.shift()] : [];
                }
                return [undefined, { rowCount: sweepRowCount }];
            },
        },
    },
});

mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        deleteObject: async (key) => {
            deletedS3Keys.push(key);
            return true;
        },
    },
});

mock.module('../src/services/image-processing.service.js', {
    namedExports: {
        generateDerivedImages: async (key, options) => {
            generateCalls.push({ key, options });
            return generateImpl(key, options);
        },
    },
});

mock.module('../src/services/collection-send.service.js', {
    namedExports: {
        completeSendIfReady: async (collectionId) => {
            completeSendCalls.push(collectionId);
            return false;
        },
        sweepSendRequests: async () => {
            sweepSendRequestsCalls += 1;
            return 0;
        },
    },
});

const { claimNextPhoto, processPhoto, recoverStuckPhotos, startWorker, stopWorker } = await import('../src/services/photo-worker.service.js');

const makePhoto = (overrides = {}) => ({
    id: 1,
    collectionId: 'collection-1',
    key: 'uploads/collection-1/IMG_0001.jpg',
    status: 'PENDING',
    processingAttempts: 1,
    ...overrides,
});

const resetState = () => {
    sqlCalls = [];
    queuedPhotos = [];
    sweepRowCount = 0;
    photoUpdateCalls = [];
    currentUpdatedRows = 1;
    photoStillExists = 1;
    deletedS3Keys = [];
    generateCalls = [];
    generateImpl = async (key) => ({ thumbnailKey: `${key}-thumb.jpg`, previewKey: `${key}-preview.jpg` });
    completeSendCalls = [];
    sweepSendRequestsCalls = 0;
};

const waitFor = async (condition, timeoutMs = 2000) => {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for the condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
};

// --- claim -------------------------------------------------------------------------

test('claimNextPhoto takes the oldest QUEUED photo atomically (FOR UPDATE SKIP LOCKED) and counts the attempt', async () => {
    resetState();
    const photo = makePhoto();
    queuedPhotos = [photo];

    const claimed = await claimNextPhoto({ retryDelayMs: 30_000 });

    assert.equal(claimed, photo);
    const { sql } = sqlCalls[0];
    assert.match(sql, /"processingStatus" = 'PROCESSING'/);
    assert.match(sql, /"processingAttempts" = "processingAttempts" \+ 1/);
    assert.match(sql, /WHERE "processingStatus" = 'QUEUED'/);
    assert.match(sql, /ORDER BY "createdAt", id\s+LIMIT 1\s+FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /RETURNING \*/);
});

test('claimNextPhoto returns null when the queue is empty', async () => {
    resetState();
    assert.equal(await claimNextPhoto({ retryDelayMs: 30_000 }), null);
});

test('claimNextPhoto only re-claims a failed photo after attempts x retry delay (backoff), never delaying a first attempt', async () => {
    resetState();

    await claimNextPhoto({ retryDelayMs: 45_000 });

    const { sql, options } = sqlCalls[0];
    assert.match(sql, /"processingAttempts" = 0\s+OR "updatedAt" <= now\(\) - \("processingAttempts" \* :retryDelayMs \* interval '1 millisecond'\)/);
    assert.deepEqual(options.replacements, { retryDelayMs: 45_000 });
});

// --- processing --------------------------------------------------------------------

test('processPhoto stores the derived keys, marks the photo DONE and then checks the pending link send', async () => {
    resetState();

    await processPhoto(makePhoto(), { maxAttempts: 3 });

    assert.deepEqual(photoUpdateCalls[0].data, {
        thumbnailKey: 'uploads/collection-1/IMG_0001.jpg-thumb.jpg',
        previewKey: 'uploads/collection-1/IMG_0001.jpg-preview.jpg',
        processingStatus: 'DONE',
        processingError: null,
    });
    // Guarded on PROCESSING: a run that lost its photo (stuck sweep) never overwrites.
    assert.deepEqual(photoUpdateCalls[0].options.where, { id: 1, processingStatus: 'PROCESSING' });
    assert.deepEqual(completeSendCalls, ['collection-1']);
});

test('processPhoto applies the watermark to a PENDING photo and none to a DELIVERED one', async () => {
    resetState();

    await processPhoto(makePhoto({ status: 'PENDING' }), { maxAttempts: 3 });
    await processPhoto(makePhoto({ id: 2, status: 'DELIVERED' }), { maxAttempts: 3 });

    assert.equal(generateCalls[0].options.watermark, true);
    assert.equal(generateCalls[1].options.watermark, false);
});

test('processPhoto puts a failed photo back in the queue, with the error, while attempts remain', async () => {
    resetState();
    generateImpl = async () => { throw new Error('connect ECONNREFUSED'); };

    await processPhoto(makePhoto({ processingAttempts: 1 }), { maxAttempts: 3 });

    assert.equal(photoUpdateCalls[0].data.processingStatus, 'QUEUED');
    assert.equal(photoUpdateCalls[0].data.processingError, 'connect ECONNREFUSED');
    assert.deepEqual(photoUpdateCalls[0].options.where, { id: 1, processingStatus: 'PROCESSING' });
    assert.deepEqual(completeSendCalls, [], 'a failed photo must not trigger the link send');
});

test('processPhoto retries then ends in FAILED once the attempts are used up', async () => {
    resetState();
    generateImpl = async () => { throw new Error('boom'); };

    for (const attempt of [1, 2, 3]) {
        await processPhoto(makePhoto({ processingAttempts: attempt }), { maxAttempts: 3 });
    }

    assert.deepEqual(photoUpdateCalls.map((call) => call.data.processingStatus), ['QUEUED', 'QUEUED', 'FAILED']);
});

test('processPhoto truncates a huge error message', async () => {
    resetState();
    generateImpl = async () => { throw new Error('x'.repeat(5000)); };

    await processPhoto(makePhoto(), { maxAttempts: 3 });

    assert.equal(photoUpdateCalls[0].data.processingError.length, 2000);
});

test('a photo deleted during its processing: derived images are removed from S3 and nothing else happens', async () => {
    resetState();
    currentUpdatedRows = 0; // the row is gone when the result is written
    photoStillExists = 0;

    await processPhoto(makePhoto(), { maxAttempts: 3 });

    assert.deepEqual(deletedS3Keys.sort(), [
        'uploads/collection-1/IMG_0001.jpg-preview.jpg',
        'uploads/collection-1/IMG_0001.jpg-thumb.jpg',
    ]);
    assert.deepEqual(completeSendCalls, []);
});

test('a photo deleted during its processing whose run then fails: the error is ignored and no retry is recorded', async () => {
    resetState();
    currentUpdatedRows = 0;
    generateImpl = async () => { throw new Error('The specified key does not exist'); };

    await assert.doesNotReject(() => processPhoto(makePhoto(), { maxAttempts: 3 }));

    assert.deepEqual(deletedS3Keys, []);
    assert.deepEqual(completeSendCalls, []);
});

test('a photo still present but no longer PROCESSING (put back in the queue by the sweep) is left alone', async () => {
    resetState();
    currentUpdatedRows = 0;
    photoStillExists = 1;

    await processPhoto(makePhoto(), { maxAttempts: 3 });

    assert.deepEqual(deletedS3Keys, [], 'the other run owns the photo and its derived files');
    assert.deepEqual(completeSendCalls, []);
});

// --- stuck photos ------------------------------------------------------------------

test('recoverStuckPhotos requeues PROCESSING photos older than the threshold, or fails them when attempts are used up', async () => {
    resetState();
    sweepRowCount = 2;

    const recovered = await recoverStuckPhotos({ stuckAfterMs: 300_000, maxAttempts: 3 });

    assert.equal(recovered, 2);
    const { sql, options } = sqlCalls[0];
    assert.match(sql, /WHERE "processingStatus" = 'PROCESSING'/);
    assert.match(sql, /"processingStartedAt" < now\(\) - \(:stuckAfterMs \* interval '1 millisecond'\)/);
    assert.match(sql, /CASE WHEN "processingAttempts" >= :maxAttempts\s+THEN 'FAILED'/);
    assert.match(sql, /ELSE 'QUEUED'/);
    assert.deepEqual(options.replacements, { maxAttempts: 3, stuckAfterMs: 300_000 });
});

// --- the loop ----------------------------------------------------------------------

const withWorkerEnv = async (env, run) => {
    const previous = {};
    for (const [name, value] of Object.entries(env)) {
        previous[name] = process.env[name];
        process.env[name] = value;
    }
    try {
        await run();
    } finally {
        await stopWorker();
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
};

test('the worker processes the queue in order, then stops cleanly', async () => {
    resetState();
    queuedPhotos = [makePhoto({ id: 1, key: 'a.jpg' }), makePhoto({ id: 2, key: 'b.jpg' }), makePhoto({ id: 3, key: 'c.jpg' })];

    await withWorkerEnv({ WORKER_POLL_INTERVAL_MS: '10', WORKER_CONCURRENCY: '1' }, async () => {
        startWorker();
        await waitFor(() => completeSendCalls.length === 3);
        await stopWorker();
    });

    assert.deepEqual(generateCalls.map((call) => call.key), ['a.jpg', 'b.jpg', 'c.jpg']);
    const claimsAfterStop = sqlCalls.filter((call) => call.sql.includes('SKIP LOCKED')).length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sqlCalls.filter((call) => call.sql.includes('SKIP LOCKED')).length, claimsAfterStop, 'no claim after stop');
});

test('the worker never processes more photos in parallel than WORKER_CONCURRENCY', async () => {
    resetState();
    queuedPhotos = [1, 2, 3, 4].map((id) => makePhoto({ id, key: `${id}.jpg` }));
    const gate = deferred();
    let running = 0;
    let maxRunning = 0;
    generateImpl = async (key) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running -= 1;
        return { thumbnailKey: `${key}-t`, previewKey: `${key}-p` };
    };

    await withWorkerEnv({ WORKER_POLL_INTERVAL_MS: '10', WORKER_CONCURRENCY: '2' }, async () => {
        startWorker();
        await waitFor(() => running === 2);
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(running, 2, 'the two other photos wait for a free slot');
        assert.equal(queuedPhotos.length, 2, 'and are not even claimed yet');
        gate.resolve();
        await waitFor(() => completeSendCalls.length === 4);
    });

    assert.equal(maxRunning, 2);
});

test('stopping the worker lets the photos in progress finish and takes no new one', async () => {
    resetState();
    queuedPhotos = [makePhoto({ id: 1, key: 'a.jpg' }), makePhoto({ id: 2, key: 'b.jpg' })];
    const gate = deferred();
    generateImpl = async (key) => {
        await gate.promise;
        return { thumbnailKey: `${key}-t`, previewKey: `${key}-p` };
    };

    await withWorkerEnv({ WORKER_POLL_INTERVAL_MS: '10', WORKER_CONCURRENCY: '1' }, async () => {
        startWorker();
        await waitFor(() => generateCalls.length === 1);

        let stopped = false;
        const stopping = stopWorker().then(() => { stopped = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(stopped, false, 'stop waits for the photo in progress');

        gate.resolve();
        await stopping;
        assert.equal(completeSendCalls.length, 1, 'the photo in progress was completed');
    });

    assert.equal(queuedPhotos.length, 1, 'the second photo was never taken');
    assert.equal(generateCalls.length, 1);
});

test('the worker recovers stuck photos and sweeps pending link requests when it starts', async () => {
    resetState();

    await withWorkerEnv({ WORKER_POLL_INTERVAL_MS: '10' }, async () => {
        startWorker();
        await waitFor(() => sweepSendRequestsCalls >= 1);
    });

    assert.ok(sqlCalls.some((call) => call.sql.includes("'PROCESSING'") && call.sql.includes('processingStartedAt" <')));
});

test('a photo that keeps failing is claimed again by the loop until it is FAILED', async () => {
    resetState();
    generateImpl = async () => { throw new Error('S3 down'); };
    // The SQL claim does the increment in the real database: mimic it here.
    let attempts = 0;
    const requeue = () => { attempts += 1; queuedPhotos = [makePhoto({ processingAttempts: attempts })]; };
    requeue();
    const originalUpdate = photoUpdateCalls.push.bind(photoUpdateCalls);
    photoUpdateCalls.push = (call) => {
        const result = originalUpdate(call);
        if (call.data.processingStatus === 'QUEUED') requeue();
        return result;
    };

    await withWorkerEnv({ WORKER_POLL_INTERVAL_MS: '10', WORKER_CONCURRENCY: '1', WORKER_MAX_ATTEMPTS: '3' }, async () => {
        startWorker();
        await waitFor(() => photoUpdateCalls.some((call) => call.data.processingStatus === 'FAILED'));
    });

    assert.deepEqual(photoUpdateCalls.map((call) => call.data.processingStatus), ['QUEUED', 'QUEUED', 'FAILED']);
});
