import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let brandingResult;
let downloadImpl;
let toResponseImpl;
let archiveInfoImpl;

// Le contrôleur importe des services qui touchent db et s3 : tout est mocké avant l'import.
mock.module('../src/services/photo.service.js', {
    namedExports: {
        getAllClientPhotosByCollectionId: async () => [{ id: 'p1' }],
        getDeliveredPhotosByCollectionId: async () => [{ id: 'p1' }],
        updatePhotoSelectionStatus: async () => true,
    },
});
mock.module('../src/services/collection.service.js', {
    namedExports: { markCollectionAsViewed: async () => {} },
});
mock.module('../src/services/collection-archive.service.js', {
    namedExports: {
        requestDeliveredDownload: async (collection) => downloadImpl(collection),
        toDownloadResponse: (kind, result) => toResponseImpl(kind, result),
        getClientArchiveInfo: async (collectionId) => archiveInfoImpl(collectionId),
    },
});
mock.module('../src/services/client.service.js', {
    namedExports: { validateCollectionSelection: async () => ({}) },
});
mock.module('../src/services/settings.service.js', {
    namedExports: { getClientBranding: async () => brandingResult() },
});

const { getClientGallery, downloadAllDeliveredPhotos, getClientArchive } = await import('../src/controller/client.controller.js');

const makeRes = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
});

const callGallery = async (status = 'SELECTING') => {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    await getClientGallery({ collection: { id: 'c1', status, viewedByCustomer: true } }, res);
    return res;
};

test('getClientGallery adds the branding block to the payload', async () => {
    const branding = { logoUrl: null, displayName: 'Emma', tagline: null, welcomeMessage: null, fontId: null, colorBg: null };
    brandingResult = () => branding;
    const res = await callGallery();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.branding, branding);
    assert.deepEqual(res.body.photos, [{ id: 'p1' }]);
    assert.ok('photographerName' in res.body);
});

test('getClientGallery answers 200 with branding: null when the settings cannot be read', async () => {
    brandingResult = () => { throw new Error('db down'); };
    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
        res = await callGallery();
    } finally {
        console.error = originalError;
    }
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.branding, null);
    assert.equal(res.body.collection.id, 'c1');
    assert.deepEqual(res.body.photos, [{ id: 'p1' }]);
});

// --- archive state of the gallery ---------------------------------------------------------------

test('a READY gallery carries the state of the "download all" button', async () => {
    brandingResult = () => null;
    archiveInfoImpl = async () => ({ status: 'DONE', sizeBytes: 1_500_000_000, photoCount: 187 });
    const res = await callGallery('READY');
    assert.deepEqual(res.body.archive, { status: 'DONE', sizeBytes: 1_500_000_000, photoCount: 187 });
});

test('a gallery that is not READY has no archive block', async () => {
    brandingResult = () => null;
    archiveInfoImpl = async () => { throw new Error('must not be called'); };
    const res = await callGallery('SELECTING');
    assert.ok(!('archive' in res.body));
});

test('a READY gallery is still served, without archive info, when the archive status cannot be read', async () => {
    brandingResult = () => null;
    archiveInfoImpl = async () => { throw new Error('db down'); };
    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
        res = await callGallery('READY');
    } finally {
        console.error = originalError;
    }
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.archive, null);
    assert.deepEqual(res.body.photos, [{ id: 'p1' }]);
});

// --- download-all ---------------------------------------------------------------------------------

const callDownloadAll = async (collection = { id: 'c1', name: 'Mariage', status: 'READY' }) => {
    const res = makeRes();
    await downloadAllDeliveredPhotos({ collection }, res);
    return res;
};

test('download-all answers with the status and body decided by the archive service', async () => {
    const asked = [];
    downloadImpl = async (collection) => { asked.push(collection.id); return { state: 'READY', url: 'https://s3/zip' }; };
    toResponseImpl = (kind, result) => ({ httpStatus: 200, body: { url: result.url, kind } });
    const res = await callDownloadAll();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { url: 'https://s3/zip', kind: 'DELIVERED' });
    assert.deepEqual(asked, ['c1']);

    toResponseImpl = () => ({ httpStatus: 202, body: { status: 'PROCESSING' } });
    assert.deepEqual((await callDownloadAll()).statusCode, 202);
    toResponseImpl = () => ({ httpStatus: 409, body: { status: 'FAILED' } });
    const failed = await callDownloadAll();
    assert.equal(failed.statusCode, 409);
    assert.deepEqual(failed.body, { status: 'FAILED' });
});

test('download-all answers 404 for a collection that is not READY', async () => {
    downloadImpl = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
    const res = await callDownloadAll({ id: 'c1', status: 'EDITING' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
});

test('download-all hides an unexpected error behind a generic 500', async () => {
    downloadImpl = async () => { throw new Error('connection to db:5432 refused'); };
    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
        res = await callDownloadAll();
    } finally {
        console.error = originalError;
    }
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.error.includes('5432'));
});

// --- archive polling ----------------------------------------------------------------------------

const callArchive = async (collection) => {
    const res = makeRes();
    await getClientArchive({ collection }, res);
    return res;
};

test('GET archive returns the state of the button for a READY collection', async () => {
    archiveInfoImpl = async (id) => ({ status: 'PROCESSING', sizeBytes: null, photoCount: null, id });
    const res = await callArchive({ id: 'c1', status: 'READY' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.archive.status, 'PROCESSING');
});

test('GET archive answers 404 outside READY, without reading anything', async () => {
    archiveInfoImpl = async () => { throw new Error('must not be called'); };
    const res = await callArchive({ id: 'c1', status: 'EDITING' });
    assert.equal(res.statusCode, 404);
});

test('GET archive answers { archive: null } when there is nothing to archive', async () => {
    archiveInfoImpl = async () => null;
    const res = await callArchive({ id: 'c1', status: 'READY' });
    assert.deepEqual(res.body, { archive: null });
});

test('GET archive hides an unexpected error behind a generic 500', async () => {
    archiveInfoImpl = async () => { throw new Error('connection to db:5432 refused'); };
    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
        res = await callArchive({ id: 'c1', status: 'READY' });
    } finally {
        console.error = originalError;
    }
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.error.includes('5432'));
});
