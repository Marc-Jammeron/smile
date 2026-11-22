import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The controller imports services that touch db and s3: everything is mocked before import.
let requestImpl;
let archivesImpl;
let retryImpl;
let wakeCalls = 0;

mock.module('../src/services/collection.service.js', {
    namedExports: {
        getAllCollections: async () => [], getCollectionById: async () => null, createCollection: async () => ({}),
        pickCollectionFields: (data) => data, UPDATABLE_COLLECTION_FIELDS: [], deleteCollection: async () => true,
        revokeCollectionAccess: async () => true, getCollectionProcessingStatus: async () => null, markCollectionAsReady: async () => ({}),
    },
});
mock.module('../src/services/collection-send.service.js', {
    namedExports: { updateCollectionOrDeferSend: async () => ({}), cancelSendRequest: async () => null, SEND_DEFERRED_MESSAGE: '' },
});
mock.module('../src/services/collection-archive.service.js', {
    namedExports: {
        requestSelectionHdDownload: async (id) => requestImpl(id),
        toDownloadResponse: (kind, result) => (result.state === 'READY'
            ? { httpStatus: 200, body: { url: result.url } }
            : { httpStatus: 202, body: { status: result.status } }),
        getCollectionArchives: async (id) => archivesImpl(id),
        retryArchive: async (id, kind) => retryImpl(id, kind),
        isArchiveKind: (kind) => ['SELECTION_HD', 'DELIVERED'].includes(kind),
    },
});
mock.module('../src/services/archive-worker.service.js', {
    namedExports: { wakeArchiveWorker: () => { wakeCalls += 1; } },
});

const { downloadSelectionHdController, getCollectionArchivesController, retryArchiveController } = await import('../src/controller/collection.controller.js');

const makeRes = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
});

const silenced = async (run) => {
    const originalError = console.error;
    console.error = () => {};
    try {
        return await run();
    } finally {
        console.error = originalError;
    }
};

beforeEach(() => { wakeCalls = 0; });

test('download-selection-hd answers 200 { url } when the ZIP is ready', async () => {
    requestImpl = async () => ({ state: 'READY', url: 'https://s3/zip' });
    const res = makeRes();
    await downloadSelectionHdController({ params: { id: 'c1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { url: 'https://s3/zip' });
});

test('download-selection-hd answers 202 while the ZIP is being prepared', async () => {
    requestImpl = async () => ({ state: 'PENDING', status: 'QUEUED' });
    const res = makeRes();
    await downloadSelectionHdController({ params: { id: 'c1' } }, res);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.body, { status: 'QUEUED' });
});

test('download-selection-hd forwards the 404 and 409 of the service, and hides unexpected errors', async () => {
    const res404 = makeRes();
    requestImpl = async () => { throw Object.assign(new Error('Collection introuvable'), { status: 404 }); };
    await silenced(() => downloadSelectionHdController({ params: { id: 'c1' } }, res404));
    assert.equal(res404.statusCode, 404);

    const res409 = makeRes();
    requestImpl = async () => { throw Object.assign(new Error('La collection doit être en phase Retouche'), { status: 409 }); };
    await silenced(() => downloadSelectionHdController({ params: { id: 'c1' } }, res409));
    assert.equal(res409.statusCode, 409);

    const res500 = makeRes();
    requestImpl = async () => { throw new Error('connection to db:5432 refused'); };
    await silenced(() => downloadSelectionHdController({ params: { id: 'c1' } }, res500));
    assert.equal(res500.statusCode, 500);
    assert.ok(!res500.body.error.includes('5432'));
});

test('GET archives returns the status of both ZIPs, 404 for an unknown collection', async () => {
    archivesImpl = async () => ({ SELECTION_HD: { kind: 'SELECTION_HD', status: 'DONE' }, DELIVERED: null });
    const res = makeRes();
    await getCollectionArchivesController({ params: { id: 'c1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.SELECTION_HD.status, 'DONE');

    archivesImpl = async () => null;
    const missing = makeRes();
    await silenced(() => getCollectionArchivesController({ params: { id: 'nope' } }, missing));
    assert.equal(missing.statusCode, 404);
});

test('retry puts a FAILED archive back in the queue and wakes the worker', async () => {
    const asked = [];
    retryImpl = async (id, kind) => { asked.push([id, kind]); return { status: 'QUEUED' }; };
    const res = makeRes();
    await retryArchiveController({ params: { id: 'c1', kind: 'SELECTION_HD' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { kind: 'SELECTION_HD', status: 'QUEUED' });
    assert.deepEqual(asked, [['c1', 'SELECTION_HD']]);
    assert.equal(wakeCalls, 1);
});

test('retry answers 409 when there is no failed archive to retry', async () => {
    retryImpl = async () => null;
    const res = makeRes();
    await silenced(() => retryArchiveController({ params: { id: 'c1', kind: 'DELIVERED' } }, res));
    assert.equal(res.statusCode, 409);
    assert.equal(wakeCalls, 0);
});

test('retry answers 400 for an unknown kind, without touching anything', async () => {
    let called = false;
    retryImpl = async () => { called = true; return {}; };
    const res = makeRes();
    await retryArchiveController({ params: { id: 'c1', kind: 'EVERYTHING' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
});
