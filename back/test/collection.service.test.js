import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';

// collection.service.js imports db.repository.js (real Postgres connection as a module
// side effect) and photo.service.js (which itself imports db/s3/image-processing), so
// everything needs mocking before import, same approach as photo.service.test.js.
let currentCollection = null;
let currentSelectedPhotos = [];
let currentDeliveredPhotos = [];
let currentNonDeliveredPhotos = [];
let currentDeliveredCount = 0;
let destroyedWhere = null;
let collectionUpdateCalls = [];
let deletedS3Keys = [];
let transactionInvoked = false;
let currentAttachmentsByPhotoId = {};

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Collection: {
            findByPk: async () => currentCollection,
            update: async (data, options) => {
                collectionUpdateCalls.push({ data, options });
                if (currentCollection) {
                    currentCollection = { ...currentCollection, ...data };
                }
                return [1];
            },
        },
        Photo: {
            findAll: async ({ where }) => {
                if (where.status === 'SELECTED') return currentSelectedPhotos;
                if (where.status === 'DELIVERED') return currentDeliveredPhotos;
                return currentNonDeliveredPhotos; // { [Op.ne]: 'DELIVERED' } case
            },
            count: async () => currentDeliveredCount,
            destroy: async ({ where }) => {
                destroyedWhere = where;
                return currentNonDeliveredPhotos.length;
            },
        },
        PhotoAttachment: {
            findAll: async ({ where }) => {
                const photoIds = Array.isArray(where.photoId) ? where.photoId : [where.photoId];
                return photoIds.flatMap((photoId) => currentAttachmentsByPhotoId[photoId] || []);
            },
        },
        sequelize: {
            transaction: async (callback) => {
                transactionInvoked = true;
                return callback({});
            },
        },
    },
});

mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        getSignedDownloadUrl: async (key) => `https://s3.example.com/signed?key=${encodeURIComponent(key)}`,
        getObjectStream: async (key) => {
            if (key === 'originals/broken.jpg') {
                throw new Error('S3 object not found');
            }
            return Readable.from([Buffer.from(`content-of-${key}`)]);
        },
        deleteObject: async (key) => {
            deletedS3Keys.push(key);
            return true;
        },
    },
});

mock.module('../src/services/image-processing.service.js', {
    namedExports: {
        generateDerivedImages: async () => ({ thumbnailKey: 'thumb', previewKey: 'preview' }),
    },
});

const { streamSelectionHdZip, markCollectionAsReady, streamDeliveredZip } = await import('../src/services/collection.service.js');

// Minimal stand-in for an Express `res`: a writable sink that flips `headersSent`
// on the first chunk, mirroring how a real http.ServerResponse behaves once
// archive.pipe(res) starts pushing bytes.
class FakeResponse extends Writable {
    constructor() {
        super();
        this.headers = {};
        this.headersSent = false;
        this.chunks = [];
    }
    setHeader(key, value) {
        this.headers[key] = value;
    }
    _write(chunk, _encoding, callback) {
        this.headersSent = true;
        this.chunks.push(chunk);
        callback();
    }
}

test('streamSelectionHdZip throws 404 when the collection does not exist', async () => {
    currentCollection = null;
    const res = new FakeResponse();

    await assert.rejects(
        () => streamSelectionHdZip('missing-collection', res),
        (error) => {
            assert.equal(error.status, 404);
            return true;
        }
    );
    assert.equal(res.headersSent, false);
});

test('streamSelectionHdZip throws 409 when the collection is not in EDITING status', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'SELECTING' };
    const res = new FakeResponse();

    await assert.rejects(
        () => streamSelectionHdZip('col-1', res),
        (error) => {
            assert.equal(error.status, 409);
            assert.match(error.message, /phase Retouche/);
            return true;
        }
    );
    assert.equal(res.headersSent, false);
});

test('streamSelectionHdZip throws 400 when no photo is SELECTED', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentSelectedPhotos = [];
    const res = new FakeResponse();

    await assert.rejects(
        () => streamSelectionHdZip('col-1', res),
        (error) => {
            assert.equal(error.status, 400);
            assert.match(error.message, /Aucune photo sélectionnée/);
            return true;
        }
    );
    assert.equal(res.headersSent, false);
});

test('streamSelectionHdZip streams a zip with the right headers when the collection is ready', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentSelectedPhotos = [
        { id: 1, key: 'originals/photo-1.jpg', originalFilename: 'IMG_0001.jpg' },
    ];
    const res = new FakeResponse();

    await streamSelectionHdZip('col-1', res);

    assert.equal(res.headers['Content-Type'], 'application/zip');
    assert.match(res.headers['Content-Disposition'], /attachment; filename="mariage-dupont-HD-\d{8}\.zip"/);
    assert.ok(res.headersSent, 'expected the zip bytes to have been written to the response');
    assert.ok(res.chunks.length > 0, 'expected at least one chunk of zip data');
});

test('streamSelectionHdZip skips a photo whose original is missing in storage without failing the whole zip', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentSelectedPhotos = [
        { id: 1, key: 'originals/broken.jpg', originalFilename: 'IMG_0001.jpg' },
        { id: 2, key: 'originals/photo-2.jpg', originalFilename: 'IMG_0002.jpg' },
    ];
    const res = new FakeResponse();

    await streamSelectionHdZip('col-1', res);

    assert.ok(res.chunks.length > 0, 'expected the zip to still be produced for the remaining photo');
});

test('streamSelectionHdZip zips a photo\'s attachments instead of its JPEG when attachments exist', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentSelectedPhotos = [
        { id: 1, key: 'originals/photo-1.jpg', originalFilename: 'IMG_0001.jpg' },
    ];
    currentAttachmentsByPhotoId = {
        1: [
            { id: 'a1', photoId: 1, s3Key: 'attachments/col-1/uuid-IMG_0001.CR2', originalFilename: 'IMG_0001.CR2' },
            { id: 'a2', photoId: 1, s3Key: 'attachments/col-1/uuid-IMG_0001.xmp', originalFilename: 'IMG_0001.xmp' },
        ],
    };
    const res = new FakeResponse();

    await streamSelectionHdZip('col-1', res);

    assert.ok(res.chunks.length > 0, 'expected the zip to contain the attachments');
    currentAttachmentsByPhotoId = {};
});

test('streamSelectionHdZip adds a _erreurs.txt entry (without aborting the stream) when a file fails partway through', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentSelectedPhotos = [
        { id: 1, key: 'originals/broken.jpg', originalFilename: 'IMG_0001.jpg' },
        { id: 2, key: 'originals/photo-2.jpg', originalFilename: 'IMG_0002.jpg' },
    ];
    currentAttachmentsByPhotoId = {};
    const res = new FakeResponse();

    await streamSelectionHdZip('col-1', res);

    const zipContent = Buffer.concat(res.chunks).toString('latin1');
    assert.ok(zipContent.includes('_erreurs.txt'), 'expected an _erreurs.txt entry to be added to the zip for the failed file');
});

test('markCollectionAsReady throws 409 when the collection is not in EDITING status', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'READY' };
    currentDeliveredCount = 1;

    await assert.rejects(
        () => markCollectionAsReady('col-1'),
        (error) => {
            assert.equal(error.status, 409);
            return true;
        }
    );
});

test('markCollectionAsReady throws 400 when no DELIVERED photo exists', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentDeliveredCount = 0;

    await assert.rejects(
        () => markCollectionAsReady('col-1'),
        (error) => {
            assert.equal(error.status, 400);
            return true;
        }
    );
});

test('markCollectionAsReady deletes non-DELIVERED photos (DB rows + S3 objects) in a transaction and flips the collection to READY', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentDeliveredCount = 2;
    currentNonDeliveredPhotos = [
        { id: 1, key: 'uploads/col-1/photo-1.jpg', thumbnailKey: 'uploads/col-1/photo-1-thumb.jpg', previewKey: 'uploads/col-1/photo-1-preview.jpg', status: 'PENDING' },
        { id: 2, key: 'uploads/col-1/photo-2.jpg', thumbnailKey: null, previewKey: 'uploads/col-1/photo-2-preview.jpg', status: 'REJECTED' },
    ];
    destroyedWhere = null;
    collectionUpdateCalls = [];
    deletedS3Keys = [];
    transactionInvoked = false;

    const updated = await markCollectionAsReady('col-1');

    assert.ok(transactionInvoked, 'expected the deletion + status flip to run inside a transaction');
    assert.deepEqual(destroyedWhere.collectionId, 'col-1');
    assert.equal(collectionUpdateCalls.length, 1);
    assert.equal(collectionUpdateCalls[0].data.status, 'READY');
    assert.equal(updated.status, 'READY');

    const expectedKeys = [
        'uploads/col-1/photo-1.jpg', 'uploads/col-1/photo-1-thumb.jpg', 'uploads/col-1/photo-1-preview.jpg',
        'uploads/col-1/photo-2.jpg', 'uploads/col-1/photo-2-preview.jpg',
    ];
    assert.deepEqual(deletedS3Keys.sort(), expectedKeys.sort());
});

test('markCollectionAsReady also deletes the S3 objects of attachments belonging to the deleted (non-DELIVERED) photos', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' };
    currentDeliveredCount = 1;
    currentNonDeliveredPhotos = [
        { id: 1, key: 'uploads/col-1/photo-1.jpg', thumbnailKey: null, previewKey: null, status: 'PENDING' },
    ];
    currentAttachmentsByPhotoId = {
        1: [
            { id: 'a1', photoId: 1, s3Key: 'attachments/col-1/uuid-photo-1.CR2', originalFilename: 'photo-1.CR2' },
            { id: 'a2', photoId: 1, s3Key: 'attachments/col-1/uuid-photo-1.xmp', originalFilename: 'photo-1.xmp' },
        ],
    };
    deletedS3Keys = [];

    await markCollectionAsReady('col-1');

    assert.ok(deletedS3Keys.includes('attachments/col-1/uuid-photo-1.CR2'));
    assert.ok(deletedS3Keys.includes('attachments/col-1/uuid-photo-1.xmp'));
    currentAttachmentsByPhotoId = {};
});

test('streamDeliveredZip throws 409 when the collection is not READY', async () => {
    const res = new FakeResponse();

    await assert.rejects(
        () => streamDeliveredZip({ id: 'col-1', name: 'Mariage Dupont', status: 'EDITING' }, res),
        (error) => {
            assert.equal(error.status, 409);
            return true;
        }
    );
    assert.equal(res.headersSent, false);
});

test('streamDeliveredZip streams only the DELIVERED photos of the requested collection', async () => {
    currentDeliveredPhotos = [
        { id: 10, key: 'uploads/col-1/final-1.jpg', originalFilename: 'FINAL_0001.jpg' },
        { id: 11, key: 'uploads/col-1/final-2.jpg', originalFilename: 'FINAL_0002.jpg' },
    ];
    const res = new FakeResponse();

    await streamDeliveredZip({ id: 'col-1', name: 'Mariage Dupont', status: 'READY' }, res);

    assert.equal(res.headers['Content-Type'], 'application/zip');
    assert.ok(res.headersSent, 'expected the zip bytes to have been written to the response');
    assert.ok(res.chunks.length > 0, 'expected at least one chunk of zip data');
});
