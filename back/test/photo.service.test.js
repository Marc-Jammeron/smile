import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// photo.service.js imports db.repository.js, which opens a real Postgres
// connection (and calls process.exit on failure) as a module side effect.
// Mock it (and s3.repository.js) before importing the service so the test
// never touches a real database or AWS.
const ORIGINAL_KEY = 'originals/collection-1/photo-1.jpg';
const PREVIEW_KEY = 'previews/collection-1/photo-1.jpg';
const THUMBNAIL_KEY = 'thumbnails/collection-1/photo-1.jpg';

const fakePhoto = {
    id: 'photo-1',
    collectionId: 'collection-1',
    key: ORIGINAL_KEY,
    previewKey: PREVIEW_KEY,
    thumbnailKey: THUMBNAIL_KEY,
    status: 'PENDING',
    toJSON() {
        return {
            id: this.id,
            collectionId: this.collectionId,
            key: this.key,
            previewKey: this.previewKey,
            thumbnailKey: this.thumbnailKey,
            status: this.status,
        };
    },
};

let lastCreatedPhotoData = null;
let currentCollectionStatus = 'SELECTING';
let currentFindByPkPhoto = fakePhoto;
let destroyedWhere = null;
let deletedS3Keys = [];
let lastGenerateDerivedImagesCall = null;
let currentAttachments = [];
let createdAttachmentData = [];

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Photo: {
            findAll: async () => [fakePhoto],
            findByPk: async () => currentFindByPkPhoto,
            create: async (data) => {
                lastCreatedPhotoData = data;
                return { ...fakePhoto, ...data, toJSON() { return { ...fakePhoto.toJSON(), ...data }; } };
            },
            destroy: async ({ where }) => {
                destroyedWhere = where;
                return 1;
            },
        },
        Collection: {
            findByPk: async () => ({ status: currentCollectionStatus }),
        },
        PhotoAttachment: {
            findAll: async () => currentAttachments,
            create: async (data) => {
                createdAttachmentData.push(data);
                return { ...data, id: `attachment-${createdAttachmentData.length}`, toJSON() { return { ...data, id: `attachment-${createdAttachmentData.length}` }; } };
            },
        },
    },
});

// Signs a URL that embeds the raw S3 key, so tests can assert on which key
// ended up in the presigned URL without needing real AWS credentials.
mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        getSignedDownloadUrl: async (key) => `https://s3.example.com/signed?key=${encodeURIComponent(key)}`,
        objectExists: async () => true,
        deleteObject: async (key) => {
            deletedS3Keys.push(key);
            return true;
        },
    },
});

mock.module('../src/services/image-processing.service.js', {
    namedExports: {
        generateDerivedImages: async (key, options) => {
            lastGenerateDerivedImagesCall = { key, options };
            return { thumbnailKey: THUMBNAIL_KEY, previewKey: PREVIEW_KEY };
        },
    },
});

const { getAllClientPhotosByCollectionId, getAllPhotosByCollectionId, confirmPhotosBatch, getPhotoDownloadFilename, deleteDeliveredPhoto } = await import('../src/services/photo.service.js');

test('getAllClientPhotosByCollectionId (client gallery path) never presigns the original S3 key', async () => {
    const [photo] = await getAllClientPhotosByCollectionId('collection-1');

    assert.ok(!photo.url.includes(encodeURIComponent(ORIGINAL_KEY)),
        `client gallery url leaked the original key: ${photo.url}`);
    assert.ok(photo.url.includes(encodeURIComponent(PREVIEW_KEY)),
        `client gallery url should be presigned on previewKey: ${photo.url}`);
});

test('getAllClientPhotosByCollectionId (client gallery path) never exposes the raw original key', async () => {
    const [photo] = await getAllClientPhotosByCollectionId('collection-1');

    assert.equal(photo.key, undefined, `client gallery payload should not contain the raw original key: ${JSON.stringify(photo)}`);
});

test('getAllPhotosByCollectionId (admin path) still presigns the original S3 key', async () => {
    const [photo] = await getAllPhotosByCollectionId('collection-1');

    assert.ok(photo.url.includes(encodeURIComponent(ORIGINAL_KEY)),
        `admin url should still be presigned on the original key: ${photo.url}`);
});

test('confirmPhotosBatch persists the uploaded filename as originalFilename', async () => {
    lastCreatedPhotoData = null;

    await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0042.jpg' },
        ],
    });

    assert.equal(lastCreatedPhotoData.originalFilename, 'IMG_0042.jpg');
});

test('getPhotoDownloadFilename uses originalFilename when present', () => {
    const filename = getPhotoDownloadFilename({ key: 'uploads/collection-1/uuid-photo.jpg', originalFilename: 'IMG_0001.jpg' });
    assert.equal(filename, 'IMG_0001.jpg');
});

test('getPhotoDownloadFilename derives a readable name from the S3 key when originalFilename is missing (legacy photos)', () => {
    const filename = getPhotoDownloadFilename({
        key: 'uploads/collection-1/3f9a1c2e-4b5d-4a3e-9f0a-1234567890ab-IMG_0002.jpg',
        originalFilename: null,
    });
    assert.equal(filename, 'IMG_0002.jpg');
});

test('confirmPhotosBatch rejects DELIVERED uploads with 409 when the collection is not in EDITING status', async () => {
    currentCollectionStatus = 'SELECTING';

    await assert.rejects(
        () => confirmPhotosBatch({
            photos: [
                { collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0042.jpg' },
            ],
            targetStatus: 'DELIVERED',
        }),
        (error) => {
            assert.equal(error.status, 409);
            return true;
        }
    );
});

test('confirmPhotosBatch accepts DELIVERED uploads when the collection is in EDITING status, without a watermark', async () => {
    currentCollectionStatus = 'EDITING';
    lastGenerateDerivedImagesCall = null;

    const { created, failed } = await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0042.jpg' },
        ],
        targetStatus: 'DELIVERED',
    });

    assert.equal(failed.length, 0);
    assert.equal(created.length, 1);
    assert.equal(lastCreatedPhotoData.status, 'DELIVERED');
    assert.equal(lastGenerateDerivedImagesCall.options.watermark, false);
});

test('confirmPhotosBatch defaults to PENDING status with a watermark when targetStatus is not provided', async () => {
    currentCollectionStatus = 'SELECTING';
    lastGenerateDerivedImagesCall = null;

    await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0043.jpg' },
        ],
    });

    assert.equal(lastCreatedPhotoData.status, 'PENDING');
    assert.equal(lastGenerateDerivedImagesCall.options.watermark, true);
});

test('confirmPhotosBatch rejects a non-jpeg filename as a main photo (never reaches generateDerivedImages)', async () => {
    currentCollectionStatus = 'SELECTING';
    lastGenerateDerivedImagesCall = null;

    const { created, failed } = await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: 'uploads/collection-1/uuid-IMG_0044.CR2', contentType: 'image/x-canon-cr2', size: 30000000, filename: 'IMG_0044.CR2' },
        ],
    });

    assert.equal(created.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(lastGenerateDerivedImagesCall, null, 'a CR2 must never be passed to generateDerivedImages');
});

test('confirmPhotosBatch creates PhotoAttachment rows (case-insensitive extension, no sharp pipeline) for attachments nested under a new photo', async () => {
    currentCollectionStatus = 'SELECTING';
    lastGenerateDerivedImagesCall = null;
    createdAttachmentData = [];

    const { created, failed, createdAttachments, failedAttachments } = await confirmPhotosBatch({
        photos: [
            {
                collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0045.jpg',
                attachments: [
                    { key: 'attachments/collection-1/uuid-IMG_0045.CR2', contentType: 'image/x-canon-cr2', size: 30000000, filename: 'IMG_0045.CR2' },
                    { key: 'attachments/collection-1/uuid-IMG_0045.xmp', contentType: 'application/xml', size: 4096, filename: 'IMG_0045.xmp' },
                ],
            },
        ],
    });

    assert.equal(failed.length, 0);
    assert.equal(created.length, 1);
    assert.equal(failedAttachments.length, 0);
    assert.equal(createdAttachmentData.length, 2);
    assert.deepEqual(createdAttachmentData.map((attachment) => attachment.originalFilename).sort(), ['IMG_0045.CR2', 'IMG_0045.xmp'].sort());
    assert.equal(createdAttachmentData.every((attachment) => attachment.photoId === created[0].id), true);
});

test('confirmPhotosBatch rejects a zero-size or blacklisted attachment filename without failing the whole batch', async () => {
    currentCollectionStatus = 'SELECTING';
    createdAttachmentData = [];

    const { created, failedAttachments } = await confirmPhotosBatch({
        photos: [
            {
                collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0046.jpg',
                attachments: [
                    { key: 'attachments/collection-1/uuid-.DS_Store', contentType: '', size: 6148, filename: '.DS_Store' },
                    { key: 'attachments/collection-1/uuid-empty.CR2', contentType: 'image/x-canon-cr2', size: 0, filename: 'empty.CR2' },
                ],
            },
        ],
    });

    assert.equal(created.length, 1);
    assert.equal(createdAttachmentData.length, 0);
    assert.equal(failedAttachments.length, 2);
});

test('confirmPhotosBatch attaches to an existing photo via attachmentsToExistingPhotos', async () => {
    createdAttachmentData = [];

    const { createdAttachments, failedAttachments } = await confirmPhotosBatch({
        photos: [],
        attachmentsToExistingPhotos: [
            {
                photoId: 'photo-1',
                attachments: [
                    { key: 'attachments/collection-1/uuid-IMG_0001.CR2', contentType: 'image/x-canon-cr2', size: 30000000, filename: 'IMG_0001.CR2' },
                ],
            },
        ],
    });

    assert.equal(failedAttachments.length, 0);
    assert.equal(createdAttachments.length, 1);
    assert.equal(createdAttachmentData[0].photoId, 'photo-1');
});

test('deleteDeliveredPhoto throws 403 when the photo is not DELIVERED', async () => {
    currentFindByPkPhoto = { ...fakePhoto, status: 'SELECTED' };

    await assert.rejects(
        () => deleteDeliveredPhoto('photo-1'),
        (error) => {
            assert.equal(error.status, 403);
            return true;
        }
    );
});

test('deleteDeliveredPhoto deletes the DB row and every associated S3 object when the photo is DELIVERED', async () => {
    currentFindByPkPhoto = { ...fakePhoto, status: 'DELIVERED' };
    destroyedWhere = null;
    deletedS3Keys = [];

    const result = await deleteDeliveredPhoto('photo-1');

    assert.equal(result, true);
    assert.deepEqual(destroyedWhere, { id: 'photo-1' });
    assert.deepEqual(deletedS3Keys.sort(), [ORIGINAL_KEY, PREVIEW_KEY, THUMBNAIL_KEY].sort());
});

test('deleteDeliveredPhoto returns null when the photo does not exist', async () => {
    currentFindByPkPhoto = null;

    const result = await deleteDeliveredPhoto('missing-photo');

    assert.equal(result, null);
});
