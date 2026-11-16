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
let createdPhotosData = [];
let lastFindAllOptions = null;
let currentMaxPosition = null;
let lastMaxArgs = null;
let currentCollectionStatus = 'SELECTING';
let currentFindByPkPhoto = fakePhoto;
let destroyedWhere = null;
let deletedS3Keys = [];
let photoUpdateCalls = [];
let currentUpdatedRows = 1;
let currentAttachments = [];
let createdAttachmentData = [];

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Photo: {
            findAll: async (options) => {
                lastFindAllOptions = options;
                return [fakePhoto];
            },
            max: async (column, options) => {
                lastMaxArgs = { column, options };
                return currentMaxPosition;
            },
            findByPk: async () => currentFindByPkPhoto,
            create: async (data) => {
                lastCreatedPhotoData = data;
                createdPhotosData.push(data);
                return { ...fakePhoto, ...data, toJSON() { return { ...fakePhoto.toJSON(), ...data }; } };
            },
            destroy: async ({ where }) => {
                destroyedWhere = where;
                return 1;
            },
            update: async (data, options) => {
                photoUpdateCalls.push({ data, options });
                return [currentUpdatedRows];
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

const { getAllClientPhotosByCollectionId, getAllPhotosByCollectionId, getDeliveredPhotosByCollectionId, getSelectedPhotosForCollection, getDeliveredPhotosForZip, confirmPhotosBatch, getPhotoDownloadFilename, deleteDeliveredPhoto, retryPhotoProcessing } = await import('../src/services/photo.service.js');

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

const POSITION_ORDER = [['position', 'ASC'], ['id', 'ASC']];

test('admin, client and delivered listings sort photos by position, then id', async () => {
    for (const list of [getAllPhotosByCollectionId, getAllClientPhotosByCollectionId, getDeliveredPhotosByCollectionId]) {
        lastFindAllOptions = null;
        await list('collection-1');
        assert.deepEqual(lastFindAllOptions.order, POSITION_ORDER, `${list.name} should order by position`);
    }
});

test('selected and delivered zip listings sort photos by position, then id', async () => {
    for (const list of [getSelectedPhotosForCollection, getDeliveredPhotosForZip]) {
        lastFindAllOptions = null;
        await list('collection-1');
        assert.deepEqual(lastFindAllOptions.order, POSITION_ORDER, `${list.name} should order by position`);
    }
});

const makeBatch = (count) => Array.from({ length: count }, (_, index) => ({
    collectionId: 'collection-1', key: `uploads/collection-1/${index}.jpg`, contentType: 'image/jpeg', size: 10, filename: `IMG_${index}.jpg`,
}));

test('confirmPhotosBatch starts positions at 0 in an empty collection and follows the array order', async () => {
    createdPhotosData = [];
    currentMaxPosition = null;

    await confirmPhotosBatch({ photos: makeBatch(3) });

    assert.deepEqual(lastMaxArgs, { column: 'position', options: { where: { collectionId: 'collection-1' } } });
    assert.deepEqual(createdPhotosData.map((photo) => [photo.originalFilename, photo.position]), [
        ['IMG_0.jpg', 0], ['IMG_1.jpg', 1], ['IMG_2.jpg', 2],
    ]);
});

test('confirmPhotosBatch continues after the highest existing position of the collection', async () => {
    createdPhotosData = [];
    currentMaxPosition = 6;

    await confirmPhotosBatch({ photos: makeBatch(2) });

    assert.deepEqual(createdPhotosData.map((photo) => photo.position), [7, 8]);
});

test('confirmPhotosBatch creates the photo as QUEUED without derived images (they are generated by the worker)', async () => {
    createdPhotosData = [];
    currentMaxPosition = null;
    currentCollectionStatus = 'SELECTING';

    const { created } = await confirmPhotosBatch({ photos: makeBatch(2) });

    assert.equal(createdPhotosData.length, 2);
    for (const data of createdPhotosData) {
        assert.equal(data.processingStatus, 'QUEUED');
        assert.equal('thumbnailKey' in data, false, 'no thumbnailKey before the worker ran');
        assert.equal('previewKey' in data, false, 'no previewKey before the worker ran');
    }
    assert.equal(created.length, 2);
});

test('confirmPhotosBatch gives DELIVERED photos positions after the existing ones of their collection', async () => {
    createdPhotosData = [];
    currentMaxPosition = 4;
    currentCollectionStatus = 'EDITING';

    await confirmPhotosBatch({ photos: makeBatch(2), targetStatus: 'DELIVERED' });

    assert.deepEqual(createdPhotosData.map((photo) => photo.position), [5, 6]);
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

test('confirmPhotosBatch accepts DELIVERED uploads when the collection is in EDITING status, queued like any other photo', async () => {
    currentCollectionStatus = 'EDITING';

    const { created, failed } = await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0042.jpg' },
        ],
        targetStatus: 'DELIVERED',
    });

    assert.equal(failed.length, 0);
    assert.equal(created.length, 1);
    // The worker reads `status` to skip the watermark of DELIVERED photos.
    assert.equal(lastCreatedPhotoData.status, 'DELIVERED');
    assert.equal(lastCreatedPhotoData.processingStatus, 'QUEUED');
});

test('confirmPhotosBatch defaults to PENDING status when targetStatus is not provided', async () => {
    currentCollectionStatus = 'SELECTING';

    await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1234, filename: 'IMG_0043.jpg' },
        ],
    });

    assert.equal(lastCreatedPhotoData.status, 'PENDING');
    assert.equal(lastCreatedPhotoData.processingStatus, 'QUEUED');
});

test('confirmPhotosBatch rejects a non-jpeg filename as a main photo (never queued for the worker)', async () => {
    currentCollectionStatus = 'SELECTING';
    createdPhotosData = [];

    const { created, failed } = await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: 'uploads/collection-1/uuid-IMG_0044.CR2', contentType: 'image/x-canon-cr2', size: 30000000, filename: 'IMG_0044.CR2' },
        ],
    });

    assert.equal(created.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(createdPhotosData.length, 0, 'a CR2 must never be queued for the image worker');
});

test('confirmPhotosBatch creates PhotoAttachment rows (case-insensitive extension, no sharp pipeline) for attachments nested under a new photo', async () => {
    currentCollectionStatus = 'SELECTING';
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

test('getAllClientPhotosByCollectionId only returns photos whose processing is DONE', async () => {
    lastFindAllOptions = null;
    await getAllClientPhotosByCollectionId('collection-1');
    assert.equal(lastFindAllOptions.where.processingStatus, 'DONE');
});

test('getDeliveredPhotosByCollectionId (client READY gallery) only returns photos whose processing is DONE', async () => {
    lastFindAllOptions = null;
    await getDeliveredPhotosByCollectionId('collection-1');
    assert.equal(lastFindAllOptions.where.processingStatus, 'DONE');
});

test('the admin listing is not filtered on processing, so queued and failed photos stay visible', async () => {
    lastFindAllOptions = null;
    await getAllPhotosByCollectionId('collection-1');
    assert.equal('processingStatus' in lastFindAllOptions.where, false);
});

test('the client photo payload does not expose the processing bookkeeping', async () => {
    const originalToJSON = fakePhoto.toJSON;
    fakePhoto.toJSON = function () {
        return { ...originalToJSON.call(this), processingStatus: 'DONE', processingAttempts: 1, processingStartedAt: new Date(), processingError: null };
    };
    try {
        const [clientPhoto] = await getAllClientPhotosByCollectionId('collection-1');
        for (const field of ['processingStatus', 'processingAttempts', 'processingStartedAt', 'processingError']) {
            assert.equal(field in clientPhoto, false, `${field} must not reach the client`);
        }
        const [adminPhoto] = await getAllPhotosByCollectionId('collection-1');
        assert.equal(adminPhoto.processingStatus, 'DONE');
    } finally {
        fakePhoto.toJSON = originalToJSON;
    }
});

test('retryPhotoProcessing puts a FAILED photo back in the queue with a fresh attempt budget', async () => {
    photoUpdateCalls = [];
    currentUpdatedRows = 1;

    const result = await retryPhotoProcessing('7');

    assert.deepEqual(result, { id: 7, processingStatus: 'QUEUED' });
    assert.equal(photoUpdateCalls[0].data.processingStatus, 'QUEUED');
    assert.equal(photoUpdateCalls[0].data.processingAttempts, 0);
    assert.deepEqual(photoUpdateCalls[0].options.where, { id: '7', processingStatus: 'FAILED' });
});

test('retryPhotoProcessing refuses a photo that is not FAILED with a 409', async () => {
    currentUpdatedRows = 0;
    currentFindByPkPhoto = { ...fakePhoto, processingStatus: 'DONE' };

    await assert.rejects(
        () => retryPhotoProcessing('photo-1'),
        (error) => {
            assert.equal(error.status, 409);
            return true;
        }
    );
    currentUpdatedRows = 1;
});

test('retryPhotoProcessing returns null when the photo does not exist', async () => {
    currentUpdatedRows = 0;
    currentFindByPkPhoto = null;

    assert.equal(await retryPhotoProcessing('missing'), null);
    currentUpdatedRows = 1;
});
