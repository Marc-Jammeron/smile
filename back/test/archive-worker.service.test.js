import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

// archive-worker.service.js imports db.repository.js (real Postgres connection as a module
// side effect), s3 and the archive service: all mocked before import. archiver is the real
// one, so the ZIP bytes that reach the (fake) upload are a real ZIP. The raw SQL (claim,
// sweep, release) can only run on Postgres: those tests assert on the statements (and the
// statements themselves were run against a real database when written).
let rows = [];
let sqlCalls = [];
let sweepRowCount = 0;
let releaseRowCount = 1;
let claimQueue = [];

let planImpl = null;          // () => ({ entries, fingerprint }), changes over time in some tests
let planCalls = 0;
let deletedArchives = [];
let storage = {};             // key -> Buffer | Error (objects readable from "S3")
let openedReads = [];
let openReads = 0;
let maxOpenReads = 0;
let uploads = [];             // every createStreamUpload call
let deletedObjects = [];
let heartbeatLost = false;

const matches = (row, where = {}) => Object.entries(where).every(([field, value]) => row[field] === value);

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        CollectionArchive: {
            findOne: async ({ where }) => rows.find((row) => matches(row, where)) ?? null,
            update: async (values, { where }) => {
                if (heartbeatLost && 'heartbeatAt' in values) return [0];
                const targets = rows.filter((row) => matches(row, where));
                targets.forEach((row) => Object.assign(row, values));
                return [targets.length];
            },
        },
        sequelize: {
            query: async (sql, options) => {
                sqlCalls.push({ sql, options });
                if (sql.includes('SKIP LOCKED')) {
                    if (claimQueue.length === 0) return [];
                    // What the UPDATE ... RETURNING does to the row it hands out.
                    const row = claimQueue.shift();
                    row.status = 'PROCESSING';
                    if (typeof row.attempts === 'number') row.attempts += 1;
                    return [row];
                }
                if (sql.includes("'QUEUED', \"attempts\" = GREATEST")) {
                    return [undefined, { rowCount: releaseRowCount }];
                }
                return [undefined, { rowCount: sweepRowCount }];
            },
        },
    },
});

mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        getObjectStream: async (key) => {
            openedReads.push(key);
            const content = storage[key];
            if (content === undefined || content instanceof Error) {
                throw content ?? new Error(`NoSuchKey: ${key}`);
            }
            openReads += 1;
            maxOpenReads = Math.max(maxOpenReads, openReads);
            const stream = Readable.from([content]);
            stream.once('end', () => { openReads -= 1; });
            return stream;
        },
        createStreamUpload: (key, body, options) => {
            const upload = { key, options, chunks: [], aborted: false, completed: false };
            upload.abort = async () => { upload.aborted = true; };
            upload.done = async () => {
                for await (const chunk of body) upload.chunks.push(chunk);
                upload.completed = true;
            };
            uploads.push(upload);
            return upload;
        },
        deleteObject: async (key) => { deletedObjects.push(key); return true; },
    },
});

mock.module('../src/services/collection-archive.service.js', {
    namedExports: {
        buildArchivePlan: async () => { planCalls += 1; return planImpl(planCalls); },
        buildArchiveS3Key: (collectionId, kind, fingerprint) => `archives/${collectionId}/${kind}-${fingerprint.slice(0, 16)}.zip`,
        deleteArchive: async (collectionId, kind) => { deletedArchives.push({ collectionId, kind }); },
    },
});

const {
    claimNextArchive, processArchive, markArchiveFailed, recoverStuckArchives, readArchiveConfig,
    startArchiveWorker, stopArchiveWorker, wakeArchiveWorker, isArchiveWorkerEnabled,
} = await import('../src/services/archive-worker.service.js');

const config = {
    maxAttempts: 3, retryDelayMs: 30_000, stuckAfterMs: 120_000,
    partSizeBytes: 16 * 1024 * 1024, heartbeatIntervalMs: 5,
};

const ENTRIES = [
    { photoId: 1, key: 'uploads/c1/1.jpg', name: 'IMG_1.jpg' },
    { photoId: 2, key: 'uploads/c1/2.jpg', name: 'IMG_2.jpg' },
    { photoId: 2, key: 'attachments/c1/2.xmp', name: 'IMG_2.xmp' },
];
const FINGERPRINT = 'f1f1f1f1f1f1f1f1f1f1f1f1';
const NEW_KEY = `archives/c1/SELECTION_HD-${FINGERPRINT.slice(0, 16)}.zip`;

const makeArchive = (overrides = {}) => {
    const row = {
        id: 'archive-1', collectionId: 'c1', kind: 'SELECTION_HD', status: 'PROCESSING',
        fingerprint: FINGERPRINT, builtFingerprint: null, s3Key: null, attempts: 1, error: null,
        ...overrides,
    };
    rows.push(row);
    return row;
};

beforeEach(() => {
    rows = [];
    sqlCalls = [];
    sweepRowCount = 0;
    releaseRowCount = 1;
    claimQueue = [];
    planCalls = 0;
    planImpl = () => ({ entries: ENTRIES, fingerprint: FINGERPRINT });
    deletedArchives = [];
    storage = Object.fromEntries(ENTRIES.map(({ key }) => [key, Buffer.from(`content of ${key}`)]));
    openedReads = [];
    openReads = 0;
    maxOpenReads = 0;
    uploads = [];
    deletedObjects = [];
    heartbeatLost = false;
});

// --- config ----------------------------------------------------------------------------

test('readArchiveConfig applies the defaults of the spec', () => {
    const config = readArchiveConfig();
    assert.equal(config.concurrency, 1);
    assert.equal(config.partSizeBytes, 16 * 1024 * 1024);
    assert.equal(config.stuckAfterMs, 120_000);
});

// --- claim -----------------------------------------------------------------------------

test('claimNextArchive takes the oldest QUEUED archive atomically (FOR UPDATE SKIP LOCKED) and counts the attempt', async () => {
    claimQueue = [{ id: 'archive-1' }];
    const archive = await claimNextArchive({ retryDelayMs: 30_000 });
    assert.equal(archive.id, 'archive-1');
    const [{ sql, options }] = sqlCalls;
    assert.match(sql, /"status" = 'QUEUED'/);
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /ORDER BY "createdAt", id/);
    assert.match(sql, /"attempts" = "attempts" \+ 1/);
    assert.match(sql, /"heartbeatAt" = now\(\)/);
    assert.deepEqual(options.replacements, { retryDelayMs: 30_000 });
});

test('claimNextArchive returns null when the queue is empty', async () => {
    assert.equal(await claimNextArchive({ retryDelayMs: 1 }), null);
});

test('claimNextArchive applies attempts x retry delay (backoff) after a failure, never to a first attempt', async () => {
    await claimNextArchive({ retryDelayMs: 30_000 });
    const [{ sql }] = sqlCalls;
    assert.match(sql, /"attempts" = 0\s+OR "updatedAt" <= now\(\) - \("attempts" \* :retryDelayMs \* interval '1 millisecond'\)/);
});

// --- a successful build -----------------------------------------------------------------

test('a successful build uploads a real ZIP under the fingerprint key and marks the archive DONE', async () => {
    const archive = makeArchive();
    await processArchive(archive, config);

    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].key, NEW_KEY);
    assert.equal(uploads[0].options.contentType, 'application/zip');
    assert.equal(uploads[0].options.partSizeBytes, 16 * 1024 * 1024);
    assert.equal(uploads[0].options.queueSize, 2);
    assert.equal(uploads[0].completed, true);
    assert.equal(uploads[0].aborted, false);

    const zip = Buffer.concat(uploads[0].chunks);
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    for (const { name } of ENTRIES) {
        assert.ok(zip.includes(Buffer.from(name)), `${name} is in the ZIP`);
    }
    assert.ok(zip.includes(Buffer.from('content of uploads/c1/1.jpg')), 'entries are stored, not compressed');

    assert.equal(archive.status, 'DONE');
    assert.equal(archive.s3Key, NEW_KEY);
    assert.equal(archive.builtFingerprint, FINGERPRINT);
    assert.equal(archive.sizeBytes, zip.length);
    assert.equal(archive.photoCount, 2); // photos, not entries: photo 2 has an attachment
    assert.equal(archive.error, null);
    assert.deepEqual(deletedObjects, []);
});

test('the build reads one S3 object at a time', async () => {
    await processArchive(makeArchive(), config);
    assert.deepEqual(openedReads, ENTRIES.map(({ key }) => key));
    assert.equal(maxOpenReads, 1);
});

test('the previous ZIP is deleted only once the new one is DONE', async () => {
    const archive = makeArchive({ s3Key: 'archives/c1/SELECTION_HD-oldoldoldoldold.zip' });
    await processArchive(archive, config);
    assert.equal(archive.status, 'DONE');
    assert.deepEqual(deletedObjects, ['archives/c1/SELECTION_HD-oldoldoldoldold.zip']);
});

test('the file is kept when the new key is the one already stored (same content)', async () => {
    const archive = makeArchive({ s3Key: NEW_KEY });
    await processArchive(archive, config);
    assert.equal(archive.status, 'DONE');
    assert.deepEqual(deletedObjects, []);
});

test('the heartbeat is recorded after each file', async () => {
    const archive = makeArchive({ heartbeatAt: null });
    await processArchive(archive, config);
    assert.ok(archive.heartbeatAt === null, 'cleared once DONE');
    // 3 entries -> 3 heartbeats, then the final update clears it: seen through the guard below
    const beats = [];
    const original = rows;
    rows = [];
    const watched = new Proxy(makeArchive({ id: 'archive-2' }), {
        set(target, prop, value) { if (prop === 'heartbeatAt' && value) beats.push(value); target[prop] = value; return true; },
    });
    rows = [watched];
    await processArchive(watched, config);
    assert.ok(beats.length >= ENTRIES.length, `expected at least ${ENTRIES.length} heartbeats, got ${beats.length}`);
    rows = original;
});

// --- failures -----------------------------------------------------------------------------

test('a missing source file fails the build and publishes nothing', async () => {
    delete storage['uploads/c1/2.jpg'];
    const archive = makeArchive();
    await processArchive(archive, config);

    assert.equal(archive.status, 'QUEUED'); // attempts remain
    assert.match(archive.error, /NoSuchKey/);
    assert.equal(archive.s3Key, null);
    assert.equal(archive.builtFingerprint, null);
    assert.equal(uploads[0].aborted, true, 'the multipart upload is aborted');
    assert.equal(uploads[0].completed, false);
});

test('the build never adds an _erreurs.txt: the ZIP is all or nothing', async () => {
    delete storage['uploads/c1/2.jpg'];
    await processArchive(makeArchive(), config);
    const bytes = Buffer.concat(uploads[0].chunks);
    assert.ok(!bytes.includes(Buffer.from('_erreurs.txt')));
});

test('a stream that breaks in the middle of a file fails the build', async () => {
    storage['uploads/c1/2.jpg'] = new Error('socket hang up');
    const archive = makeArchive();
    await processArchive(archive, config);
    assert.equal(archive.status, 'QUEUED');
    assert.match(archive.error, /socket hang up/);
    assert.equal(uploads[0].aborted, true);
});

test('a failed S3 upload fails the build and keeps the previous ZIP', async () => {
    const s3 = (await import('../src/repository/s3.repository.js')).default;
    const original = s3.createStreamUpload;
    s3.createStreamUpload = (key, body) => {
        const upload = { key, aborted: false, abort: async () => { upload.aborted = true; }, done: async () => { throw new Error('AccessDenied'); } };
        uploads.push(upload);
        return upload;
    };
    try {
        const archive = makeArchive({ s3Key: 'archives/c1/SELECTION_HD-previous.zip' });
        await processArchive(archive, config);
        assert.equal(archive.status, 'QUEUED');
        assert.match(archive.error, /AccessDenied/);
        assert.equal(archive.s3Key, 'archives/c1/SELECTION_HD-previous.zip');
        assert.deepEqual(deletedObjects, []);
    } finally {
        s3.createStreamUpload = original;
    }
});

test('a failed build waits for lib-storage to finish aborting the multipart upload before it returns', async () => {
    // lib-storage rejects done() only once its own AbortMultipartUpload request is over, but a
    // direct upload.abort() would reject it at once and leave that request running unattended.
    const s3 = (await import('../src/repository/s3.repository.js')).default;
    const original = s3.createStreamUpload;
    const events = [];
    s3.createStreamUpload = (key, body) => {
        const upload = {
            abort: async () => { events.push('abort() called'); },
            done: async () => {
                try {
                    for await (const chunk of body) void chunk;
                } catch (error) {
                    await new Promise((resolve) => setTimeout(resolve, 30)); // the AbortMultipartUpload request
                    events.push('multipart cleanup finished');
                    throw error;
                }
            },
        };
        uploads.push(upload);
        return upload;
    };
    delete storage['uploads/c1/2.jpg'];
    try {
        await processArchive(makeArchive(), config);
        events.push('processArchive returned');
    } finally {
        s3.createStreamUpload = original;
    }
    assert.deepEqual(events, ['multipart cleanup finished', 'abort() called', 'processArchive returned']);
});

test('markArchiveFailed retries while attempts remain, then FAILED', async () => {
    const retried = makeArchive({ id: 'a', attempts: 2 });
    assert.deepEqual(await markArchiveFailed(retried, new Error('boom'), 3), { updated: true, exhausted: false });
    assert.equal(retried.status, 'QUEUED');

    const exhausted = makeArchive({ id: 'b', attempts: 3 });
    assert.deepEqual(await markArchiveFailed(exhausted, new Error('boom'), 3), { updated: true, exhausted: true });
    assert.equal(exhausted.status, 'FAILED');
    assert.equal(exhausted.error, 'boom');
});

test('an archive that keeps failing ends in FAILED after maxAttempts runs', async () => {
    delete storage['uploads/c1/1.jpg'];
    const archive = makeArchive({ attempts: 0 });
    for (let run = 1; run <= 3; run += 1) {
        archive.status = 'PROCESSING';
        archive.attempts = run; // what the claim does
        await processArchive(archive, config);
    }
    assert.equal(archive.status, 'FAILED');
    assert.equal(archive.s3Key, null);
});

test('a huge error message is truncated', async () => {
    const archive = makeArchive();
    await markArchiveFailed(archive, new Error('x'.repeat(5000)), 3);
    assert.equal(archive.error.length, 2000);
});

// --- end check ------------------------------------------------------------------------------

test('end check: content changed during the build -> the ZIP is discarded and another pass is queued', async () => {
    // 1st call: plan at the start; 2nd call: plan at the end, an attachment has moved.
    planImpl = (call) => call === 1
        ? { entries: ENTRIES, fingerprint: FINGERPRINT }
        : { entries: ENTRIES.slice(0, 2), fingerprint: 'a2a2a2a2a2a2a2a2a2a2a2a2' };
    const archive = makeArchive({ s3Key: 'archives/c1/SELECTION_HD-previous.zip', attempts: 2 });
    await processArchive(archive, config);

    assert.equal(archive.status, 'QUEUED');
    assert.equal(archive.fingerprint, 'a2a2a2a2a2a2a2a2a2a2a2a2');
    assert.equal(archive.attempts, 0, 'not a failure');
    assert.equal(archive.builtFingerprint, null);
    assert.equal(archive.s3Key, 'archives/c1/SELECTION_HD-previous.zip', 'the previous ZIP stays');
    assert.deepEqual(deletedObjects, [NEW_KEY], 'the ZIP just built is removed');
});

test('end check: an ensureArchive that moved the target during the build triggers another pass', async () => {
    const archive = makeArchive();
    // ensureArchive runs while the last file is being read
    const s3 = (await import('../src/repository/s3.repository.js')).default;
    const original = s3.getObjectStream;
    s3.getObjectStream = async (key) => {
        if (key === 'attachments/c1/2.xmp') archive.fingerprint = 'b3b3b3b3b3b3b3b3b3b3b3b3';
        return original(key);
    };
    try {
        await processArchive(archive, config);
    } finally {
        s3.getObjectStream = original;
    }
    assert.equal(archive.status, 'QUEUED');
    assert.equal(archive.fingerprint, 'b3b3b3b3b3b3b3b3b3b3b3b3', 'the new target is left as ensureArchive set it');
    assert.equal(archive.builtFingerprint, null);
    assert.deepEqual(deletedObjects, [NEW_KEY]);
});

test('the target is brought in line with what is built when a trigger had not run yet', async () => {
    const archive = makeArchive({ fingerprint: 'stale-target' });
    await processArchive(archive, config);
    assert.equal(archive.status, 'DONE');
    assert.equal(archive.fingerprint, FINGERPRINT);
    assert.equal(archive.builtFingerprint, FINGERPRINT);
});

test('nothing left to archive: the archive is removed and nothing is uploaded', async () => {
    planImpl = () => ({ entries: [], fingerprint: 'empty' });
    await processArchive(makeArchive(), config);
    assert.deepEqual(deletedArchives, [{ collectionId: 'c1', kind: 'SELECTION_HD' }]);
    assert.equal(uploads.length, 0);
});

test('an archive deleted in the middle of its build: the run is abandoned and the upload aborted', async () => {
    const archive = makeArchive();
    const s3 = (await import('../src/repository/s3.repository.js')).default;
    const original = s3.getObjectStream;
    s3.getObjectStream = async (key) => {
        if (key === 'attachments/c1/2.xmp') rows = rows.filter((row) => row !== archive); // collection moved to READY
        return original(key);
    };
    try {
        await processArchive(archive, config);
    } finally {
        s3.getObjectStream = original;
    }
    // The heartbeat after the last file finds no row: the run is abandoned, the upload aborted.
    assert.equal(uploads[0].completed, false);
    assert.equal(uploads[0].aborted, true);
    assert.equal(rows.length, 0);
});

test('an archive deleted at the very end of its build: the file just uploaded is removed', async () => {
    const archive = makeArchive();
    // The collection goes READY (row deleted) after the last file, during the end check.
    planImpl = (call) => {
        if (call === 2) rows = rows.filter((row) => row !== archive);
        return { entries: ENTRIES, fingerprint: FINGERPRINT };
    };
    await processArchive(archive, config);
    assert.equal(uploads[0].completed, true);
    assert.deepEqual(deletedObjects, [NEW_KEY]);
    assert.equal(rows.length, 0);
});

// --- lost job, shutdown -----------------------------------------------------------------------

test('a job that is no longer ours (heartbeat matches no row) is abandoned without recording a failure', async () => {
    heartbeatLost = true;
    const archive = makeArchive();
    await processArchive(archive, config);
    assert.equal(archive.status, 'PROCESSING', 'left to whoever owns it now');
    assert.equal(archive.error, null);
    assert.equal(uploads[0].aborted, true);
});

test('a shutdown abandons the build, aborts the upload and puts the archive back in the queue without using an attempt', async () => {
    const controller = new AbortController();
    const archive = makeArchive();
    const s3 = (await import('../src/repository/s3.repository.js')).default;
    const original = s3.getObjectStream;
    s3.getObjectStream = async (key) => {
        if (key === 'uploads/c1/2.jpg') controller.abort(); // SIGTERM in the middle of the build
        return original(key);
    };
    try {
        await processArchive(archive, config, { signal: controller.signal });
    } finally {
        s3.getObjectStream = original;
    }
    assert.equal(uploads[0].aborted, true);
    assert.equal(uploads[0].completed, false);
    const release = sqlCalls.find(({ sql }) => sql.includes('GREATEST'));
    assert.ok(release, 'the release statement ran');
    assert.match(release.sql, /"status" = 'QUEUED', "attempts" = GREATEST\("attempts" - 1, 0\)/);
    assert.match(release.sql, /AND "status" = 'PROCESSING'/);
    assert.deepEqual(release.options.replacements, { id: 'archive-1' });
    assert.equal(archive.builtFingerprint, null);
});

// --- stuck sweep ------------------------------------------------------------------------------

test('recoverStuckArchives measures the threshold on the heartbeat, not on the total duration', async () => {
    sweepRowCount = 2;
    const recovered = await recoverStuckArchives({ stuckAfterMs: 120_000, maxAttempts: 3 });
    assert.equal(recovered, 2);
    const [{ sql, options }] = sqlCalls;
    assert.match(sql, /"status" = 'PROCESSING'/);
    assert.match(sql, /COALESCE\("heartbeatAt", "startedAt"\) < now\(\) - \(:stuckAfterMs \* interval '1 millisecond'\)/);
    assert.deepEqual(options.replacements, { maxAttempts: 3, stuckAfterMs: 120_000 });
});

test('recoverStuckArchives requeues, or fails once the attempts are used up', async () => {
    await recoverStuckArchives({ stuckAfterMs: 1, maxAttempts: 3 });
    const [{ sql }] = sqlCalls;
    assert.match(sql, /CASE WHEN "attempts" >= :maxAttempts\s+THEN 'FAILED'::"enum_CollectionArchives_status"\s+ELSE 'QUEUED'::"enum_CollectionArchives_status" END/);
});

test('recoverStuckArchives reports nothing when no archive is stuck', async () => {
    assert.equal(await recoverStuckArchives({ stuckAfterMs: 1, maxAttempts: 3 }), 0);
});

// --- the loop -----------------------------------------------------------------------------------

const waitFor = async (condition, timeoutMs = 2000) => {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for the condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

const withLoopEnv = async (env, run) => {
    const names = ['WORKER_POLL_INTERVAL_MS', 'WORKER_ARCHIVE_CONCURRENCY', ...Object.keys(env)];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { WORKER_POLL_INTERVAL_MS: '10', ...env });
    try {
        await run();
    } finally {
        await stopArchiveWorker();
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
};

// A queued archive, as the claim would return it (same object as the row, which is how the
// fake table sees the updates).
const enqueue = (id) => {
    const row = makeArchive({ id, status: 'QUEUED', attempts: 0 });
    claimQueue.push(row);
    return row;
};

test('the archive worker is enabled unless WORKER_ARCHIVE_ENABLED=false', () => {
    const saved = process.env.WORKER_ARCHIVE_ENABLED;
    try {
        delete process.env.WORKER_ARCHIVE_ENABLED;
        assert.equal(isArchiveWorkerEnabled(), true);
        process.env.WORKER_ARCHIVE_ENABLED = 'false';
        assert.equal(isArchiveWorkerEnabled(), false);
    } finally {
        if (saved === undefined) delete process.env.WORKER_ARCHIVE_ENABLED; else process.env.WORKER_ARCHIVE_ENABLED = saved;
    }
});

test('the worker builds the queued archives in order, then stops cleanly', async () => {
    await withLoopEnv({}, async () => {
        const first = enqueue('archive-a');
        const second = enqueue('archive-b');
        startArchiveWorker();
        await waitFor(() => first.status === 'DONE' && second.status === 'DONE');
        assert.deepEqual(uploads.map(({ key }) => key), [NEW_KEY, NEW_KEY]);
        await stopArchiveWorker();
        enqueue('archive-c');
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(rows.find((row) => row.id === 'archive-c').status, 'QUEUED', 'nothing is taken after the stop');
    });
});

test('the worker never builds more ZIPs in parallel than WORKER_ARCHIVE_CONCURRENCY', async () => {
    await withLoopEnv({ WORKER_ARCHIVE_CONCURRENCY: '1' }, async () => {
        const s3 = (await import('../src/repository/s3.repository.js')).default;
        const original = s3.getObjectStream;
        let inFlight = 0;
        let maxInFlight = 0;
        s3.getObjectStream = async (key) => {
            if (key === ENTRIES[0].key) {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
            if (key === ENTRIES[2].key) inFlight -= 1;
            return original(key);
        };
        try {
            const first = enqueue('archive-a');
            const second = enqueue('archive-b');
            startArchiveWorker();
            await waitFor(() => first.status === 'DONE' && second.status === 'DONE');
            assert.equal(maxInFlight, 1);
        } finally {
            s3.getObjectStream = original;
        }
    });
});

test('with a higher concurrency, two ZIPs are built at the same time', async () => {
    await withLoopEnv({ WORKER_ARCHIVE_CONCURRENCY: '2' }, async () => {
        const s3 = (await import('../src/repository/s3.repository.js')).default;
        const original = s3.getObjectStream;
        let inFlight = 0;
        let maxInFlight = 0;
        s3.getObjectStream = async (key) => {
            if (key === ENTRIES[0].key) {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 40));
            }
            if (key === ENTRIES[2].key) inFlight -= 1;
            return original(key);
        };
        try {
            const first = enqueue('archive-a');
            const second = enqueue('archive-b');
            startArchiveWorker();
            await waitFor(() => first.status === 'DONE' && second.status === 'DONE');
            assert.equal(maxInFlight, 2);
        } finally {
            s3.getObjectStream = original;
        }
    });
});

test('stopping the worker interrupts the build in progress: upload aborted, archive back in the queue, nothing published', async () => {
    await withLoopEnv({}, async () => {
        const s3 = (await import('../src/repository/s3.repository.js')).default;
        const original = s3.getObjectStream;
        let reachedSecondFile = false;
        s3.getObjectStream = async (key) => {
            if (key === ENTRIES[1].key) {
                reachedSecondFile = true;
                await new Promise((resolve) => setTimeout(resolve, 200)); // a slow read: the stop comes in the middle
            }
            return original(key);
        };
        try {
            const archive = enqueue('archive-a');
            startArchiveWorker();
            await waitFor(() => reachedSecondFile);
            await stopArchiveWorker();

            assert.equal(uploads[0].aborted, true);
            assert.equal(uploads[0].completed, false);
            assert.equal(archive.builtFingerprint, null);
            assert.ok(sqlCalls.some(({ sql }) => sql.includes('GREATEST("attempts" - 1, 0)')), 'released without using an attempt');
        } finally {
            s3.getObjectStream = original;
        }
    });
});

test('the worker recovers stuck archives when it starts, and then every minute', async () => {
    await withLoopEnv({}, async () => {
        startArchiveWorker();
        await waitFor(() => sqlCalls.some(({ sql }) => sql.includes('COALESCE("heartbeatAt", "startedAt")')));
    });
});

test('wakeArchiveWorker does nothing when the worker is not running', () => {
    assert.doesNotThrow(() => wakeArchiveWorker());
});

test('starting the worker twice returns the same worker', async () => {
    await withLoopEnv({}, async () => {
        assert.equal(startArchiveWorker(), startArchiveWorker());
    });
});
