import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let brandingResult;

// Le contrôleur importe des services qui touchent db et s3 : tout est mocké avant l'import.
mock.module('../src/services/photo.service.js', {
    namedExports: {
        getAllClientPhotosByCollectionId: async () => [{ id: 'p1' }],
        getDeliveredPhotosByCollectionId: async () => [{ id: 'p1' }],
        updatePhotoSelectionStatus: async () => true,
    },
});
mock.module('../src/services/collection.service.js', {
    namedExports: { markCollectionAsViewed: async () => {}, streamDeliveredZip: async () => {} },
});
mock.module('../src/services/client.service.js', {
    namedExports: { validateCollectionSelection: async () => ({}) },
});
mock.module('../src/services/settings.service.js', {
    namedExports: { getClientBranding: async () => brandingResult() },
});

const { getClientGallery } = await import('../src/controller/client.controller.js');

const callGallery = async () => {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    await getClientGallery({ collection: { id: 'c1', status: 'SELECTING', viewedByCustomer: true } }, res);
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
