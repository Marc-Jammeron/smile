import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// photo.service.js imports db.repository.js, which opens a real Postgres
// connection (and calls process.exit on failure) as a module side effect.
// Mock it (and s3.repository.js) before importing the service so the test
// never touches a real database or AWS.
const ORIGINAL_KEY = 'uploads/collection-1/photo-1.jpg';
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
let processingDelayByKey = {};
let currentCollectionStatus = 'SELECTING';
let currentFindByPkPhoto = fakePhoto;
let destroyedWhere = null;
let deletedS3Keys = [];
let lastGenerateDerivedImagesCall = null;
let currentAttachments = [];
let signedDownloads = [];
let attachmentFindAllCalls = [];
let currentFindAllPhotos = null;
let headResult = { size: 1234, contentType: 'image/jpeg' };
let activeGenerations = 0;
let maxActiveGenerations = 0;
let generationCalls = [];
let watermarkLoads = 0;
let watermarkLoadError = null;
const SHARED_WATERMARK = { image: 'watermark-image', position: 'southeast', opacity: 0.5, size: null, margin: 24 };
let createdAttachmentData = [];

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Photo: {
            findAll: async (options) => {
                lastFindAllOptions = options;
                return currentFindAllPhotos ?? [fakePhoto];
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
        },
        Collection: {
            findByPk: async () => ({ status: currentCollectionStatus }),
        },
        PhotoAttachment: {
            findAll: async (options) => {
                attachmentFindAllCalls.push(options);
                return currentAttachments;
            },
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
        getSignedDownloadUrl: async (key, options) => {
            signedDownloads.push({ key, expiresIn: options?.expiresIn });
            return `https://s3.example.com/signed?key=${encodeURIComponent(key)}`;
        },
        getSignedUploadUrl: async (collectionId, filename) => ({ url: 'https://s3.example.com/put', key: `uploads/${collectionId}/uuid-${filename}` }),
        getSignedAttachmentUploadUrl: async (collectionId, filename) => ({ url: 'https://s3.example.com/put', key: `attachments/${collectionId}/uuid-${filename}` }),
        objectExists: async () => true,
        headObject: async () => headResult,
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
            generationCalls.push({ key, options });
            activeGenerations += 1;
            maxActiveGenerations = Math.max(maxActiveGenerations, activeGenerations);
            try {
                await new Promise((resolve) => setTimeout(resolve, processingDelayByKey[key] ?? 0));
            } finally {
                activeGenerations -= 1;
            }
            return { thumbnailKey: THUMBNAIL_KEY, previewKey: PREVIEW_KEY };
        },
    },
});

mock.module('../src/services/settings.service.js', {
    namedExports: {
        loadWatermarkConfig: async () => {
            watermarkLoads += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (watermarkLoadError) {
                throw watermarkLoadError;
            }
            return SHARED_WATERMARK;
        },
    },
});

const { getPhotoById, createPhotosBatch, getAllClientPhotosByCollectionId, getAllPhotosByCollectionId, getDeliveredPhotosByCollectionId, getSelectedPhotosForCollection, getDeliveredPhotosForZip, confirmPhotosBatch, getPhotoDownloadFilename, deleteDeliveredPhoto } = await import('../src/services/photo.service.js');

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

test('confirmPhotosBatch does not depend on the completion order of the parallel processing', async () => {
    createdPhotosData = [];
    currentMaxPosition = null;
    processingDelayByKey = { 'uploads/collection-1/0.jpg': 30 };

    await confirmPhotosBatch({ photos: makeBatch(2) });
    processingDelayByKey = {};

    // IMG_1 finishes first (created first) yet keeps its later position.
    assert.deepEqual(createdPhotosData.map((photo) => [photo.originalFilename, photo.position]), [
        ['IMG_1.jpg', 1], ['IMG_0.jpg', 0],
    ]);
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


// --- Step C2: input validation, key ownership, presigned URL lifetimes ---

const fileDescriptors = (count) => Array.from({ length: count }, (_, index) => ({ filename: `IMG_${index}.jpg`, contentType: 'image/jpeg' }));

test('createPhotosBatch accepts exactly 50 files and rejects 51 with a 400 and a clear message', async () => {
    currentCollectionStatus = 'SELECTING';
    const accepted = await createPhotosBatch({ collectionId: 'collection-1', files: fileDescriptors(50) });
    assert.equal(accepted.length, 50);

    await assert.rejects(
        () => createPhotosBatch({ collectionId: 'collection-1', files: fileDescriptors(51) }),
        (error) => {
            assert.equal(error.status, 400);
            assert.match(error.message, /Too many files .*51.*max 50/);
            return true;
        }
    );
});

test('createPhotosBatch rejects a missing body, a missing collectionId and non-array files with a 400', async () => {
    for (const body of [undefined, {}, { collectionId: 'collection-1' }, { collectionId: 'collection-1', files: 'nope' }, { files: [] }]) {
        await assert.rejects(() => createPhotosBatch(body), (error) => {
            assert.equal(error.status, 400, JSON.stringify(body));
            return true;
        });
    }
});

test('confirmPhotosBatch accepts exactly 10 photos and rejects 11 with a 400 before touching anything', async () => {
    currentCollectionStatus = 'SELECTING';
    createdPhotosData = [];
    currentMaxPosition = null;
    const { created } = await confirmPhotosBatch({ photos: makeBatch(10) });
    assert.equal(created.length, 10);

    createdPhotosData = [];
    lastGenerateDerivedImagesCall = null;
    await assert.rejects(
        () => confirmPhotosBatch({ photos: makeBatch(11) }),
        (error) => {
            assert.equal(error.status, 400);
            assert.match(error.message, /Too many photos .*11.*max 10/);
            return true;
        }
    );
    assert.equal(createdPhotosData.length, 0);
    assert.equal(lastGenerateDerivedImagesCall, null);
});

test('confirmPhotosBatch rejects non-array photos / attachmentsToExistingPhotos with a 400', async () => {
    for (const body of [{ photos: 'x' }, { photos: null }, { attachmentsToExistingPhotos: {} }, { photos: [null] }, { photos: [{ attachments: 'x' }] }, { attachmentsToExistingPhotos: [{ photoId: 'photo-1' }] }]) {
        await assert.rejects(() => confirmPhotosBatch(body), (error) => {
            assert.equal(error.status, 400, JSON.stringify(body));
            return true;
        });
    }
});

const attachmentPayloads = (count) => Array.from({ length: count }, (_, index) => ({
    key: `attachments/collection-1/uuid-IMG_${index}.CR2`, contentType: 'image/x-canon-cr2', size: 100, filename: `IMG_${index}.CR2`,
}));

test('confirmPhotosBatch accepts 50 attachments in total (nested + existing photos) and rejects 51 with a 400', async () => {
    currentCollectionStatus = 'SELECTING';
    currentFindByPkPhoto = fakePhoto;
    createdAttachmentData = [];
    const accepted = await confirmPhotosBatch({
        photos: [],
        attachmentsToExistingPhotos: [{ photoId: 'photo-1', attachments: attachmentPayloads(50) }],
    });
    assert.equal(accepted.createdAttachments.length, 50);

    await assert.rejects(
        () => confirmPhotosBatch({
            photos: [{ collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1, filename: 'IMG_1.jpg', attachments: attachmentPayloads(1) }],
            attachmentsToExistingPhotos: [{ photoId: 'photo-1', attachments: attachmentPayloads(50) }],
        }),
        (error) => {
            assert.equal(error.status, 400);
            assert.match(error.message, /Too many attachments .*51.*max 50/);
            return true;
        }
    );
});

test('confirmPhotosBatch refuses (per photo) a key that was not issued for the photo\'s collection', async () => {
    currentCollectionStatus = 'SELECTING';
    createdPhotosData = [];
    lastGenerateDerivedImagesCall = null;

    const { created, failed } = await confirmPhotosBatch({
        photos: [
            { collectionId: 'collection-1', key: 'uploads/other-collection/uuid-IMG_1.jpg', contentType: 'image/jpeg', size: 1, filename: 'IMG_1.jpg' },
            { collectionId: 'collection-1', key: 'branding/watermark/x.jpg', contentType: 'image/jpeg', size: 1, filename: 'IMG_2.jpg' },
            { collectionId: 'collection-1', key: 'attachments/collection-1/uuid-IMG_3.jpg', contentType: 'image/jpeg', size: 1, filename: 'IMG_3.jpg' },
            { collectionId: 'collection-1', key: 'uploads/collection-1/uuid-IMG_4.jpg', contentType: 'image/jpeg', size: 1, filename: 'IMG_4.jpg' },
        ],
    });

    assert.deepEqual(created.map((photo) => photo.originalFilename), ['IMG_4.jpg']);
    assert.equal(failed.length, 3);
    assert.equal(createdPhotosData.length, 1);
});

test('confirmPhotosBatch refuses an attachment whose key is not under attachments/<collectionId>/ (nested and existing photo)', async () => {
    currentCollectionStatus = 'SELECTING';
    currentFindByPkPhoto = fakePhoto;
    createdAttachmentData = [];
    const badAttachment = { key: 'uploads/collection-1/uuid-IMG_9.CR2', contentType: 'image/x-canon-cr2', size: 100, filename: 'IMG_9.CR2' };
    const foreignAttachment = { key: 'attachments/other/uuid-IMG_9.CR2', contentType: 'image/x-canon-cr2', size: 100, filename: 'IMG_9.CR2' };

    const { created, failedAttachments, createdAttachments } = await confirmPhotosBatch({
        photos: [{ collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 1, filename: 'IMG_1.jpg', attachments: [badAttachment] }],
        attachmentsToExistingPhotos: [{ photoId: 'photo-1', attachments: [foreignAttachment] }],
    });

    assert.equal(created.length, 1);
    assert.equal(createdAttachments.length, 0);
    assert.equal(createdAttachmentData.length, 0);
    assert.deepEqual(failedAttachments.map((failure) => failure.key).sort(), [badAttachment.key, foreignAttachment.key].sort());
});

test('admin DTO presigns the original for 900 s and the thumbnail / preview for 3600 s', async () => {
    signedDownloads = [];
    await getAllPhotosByCollectionId('collection-1');
    const ttlOf = (key) => signedDownloads.find((signed) => signed.key === key).expiresIn;
    assert.equal(ttlOf(ORIGINAL_KEY), 900);
    assert.equal(ttlOf(THUMBNAIL_KEY), 3600);
    assert.equal(ttlOf(PREVIEW_KEY), 3600);
});

test('client DTO only presigns preview and thumbnail, both for 3600 s, and never the original', async () => {
    signedDownloads = [];
    await getAllClientPhotosByCollectionId('collection-1');
    assert.ok(signedDownloads.length > 0);
    assert.ok(signedDownloads.every((signed) => signed.expiresIn === 3600), JSON.stringify(signedDownloads));
    assert.ok(signedDownloads.every((signed) => signed.key !== ORIGINAL_KEY));
});


// --- Step C3: bounded image processing, watermark resolved once per request, aborted requests ---

const resetGenerationTracking = () => {
    activeGenerations = 0;
    maxActiveGenerations = 0;
    generationCalls = [];
    watermarkLoads = 0;
    watermarkLoadError = null;
    createdPhotosData = [];
    currentMaxPosition = null;
    processingDelayByKey = {};
};

const slowBatch = (count, prefix = 'slow') => {
    const photos = Array.from({ length: count }, (_, index) => ({
        collectionId: 'collection-1', key: `uploads/collection-1/${prefix}-${index}.jpg`, contentType: 'image/jpeg', size: 10, filename: `${prefix}_${index}.jpg`,
    }));
    for (const photo of photos) {
        processingDelayByKey[photo.key] = 15;
    }
    return photos;
};

test('confirmPhotosBatch never processes more than 2 photos at once (default IMAGE_PROCESSING_CONCURRENCY)', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();

    const { created, failed } = await confirmPhotosBatch({ photos: slowBatch(8) });

    assert.equal(created.length, 8);
    assert.equal(failed.length, 0);
    assert.equal(maxActiveGenerations, 2);
});

test('the bound is process-wide: two overlapping requests still share the same 2 slots', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();

    const [first, second] = await Promise.all([
        confirmPhotosBatch({ photos: slowBatch(5, 'a') }),
        confirmPhotosBatch({ photos: slowBatch(5, 'b') }),
    ]);

    assert.equal(first.created.length + second.created.length, 10);
    assert.equal(maxActiveGenerations, 2);
});

test('confirmPhotosBatch keeps the result shape and the input order of positions under the bound', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    const photos = slowBatch(4);
    photos.push({ collectionId: 'collection-1', key: 'uploads/collection-1/bad.CR2', contentType: 'image/x-canon-cr2', size: 10, filename: 'bad.CR2' });

    const result = await confirmPhotosBatch({ photos });

    assert.deepEqual(Object.keys(result).sort(), ['created', 'createdAttachments', 'failed', 'failedAttachments']);
    assert.deepEqual(result.failed.map((failure) => failure.key), ['uploads/collection-1/bad.CR2']);
    assert.deepEqual(result.created.map((photo) => photo.originalFilename).sort(), ['slow_0.jpg', 'slow_1.jpg', 'slow_2.jpg', 'slow_3.jpg']);
    const positionByName = Object.fromEntries(createdPhotosData.map((photo) => [photo.originalFilename, photo.position]));
    assert.deepEqual(positionByName, { 'slow_0.jpg': 0, 'slow_1.jpg': 1, 'slow_2.jpg': 2, 'slow_3.jpg': 3 });
});

test('the watermark config is loaded once per request and shared with every photo', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();

    await confirmPhotosBatch({ photos: slowBatch(5) });

    assert.equal(watermarkLoads, 1);
    assert.equal(generationCalls.length, 5);
    assert.ok(generationCalls.every(({ options }) => options.watermark === true && options.watermarkConfig === SHARED_WATERMARK));
});

test('each request reloads the watermark config (settings changes are picked up, no durable cache)', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();

    await confirmPhotosBatch({ photos: slowBatch(2, 'one') });
    await confirmPhotosBatch({ photos: slowBatch(2, 'two') });

    assert.equal(watermarkLoads, 2);
});

test('DELIVERED photos never load the watermark config', async () => {
    currentCollectionStatus = 'EDITING';
    resetGenerationTracking();

    await confirmPhotosBatch({ photos: slowBatch(3), targetStatus: 'DELIVERED' });

    assert.equal(watermarkLoads, 0);
    assert.ok(generationCalls.every(({ options }) => options.watermark === false && options.watermarkConfig === undefined));
});

test('a batch whose photos are all refused never loads the watermark config', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();

    const { failed } = await confirmPhotosBatch({
        photos: [{ collectionId: 'collection-1', key: 'uploads/collection-1/a.CR2', contentType: 'image/x-canon-cr2', size: 1, filename: 'a.CR2' }],
    });

    assert.equal(failed.length, 1);
    assert.equal(watermarkLoads, 0);
});

test('a watermark config failure is reported per photo in `failed` (same error for all), one load attempt', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    watermarkLoadError = new Error('Watermark image missing');

    const { created, failed } = await confirmPhotosBatch({ photos: slowBatch(3) });

    assert.equal(created.length, 0);
    assert.equal(failed.length, 3);
    assert.ok(failed.every((failure) => failure.error === 'Watermark image missing'));
    assert.equal(watermarkLoads, 1);
    assert.equal(generationCalls.length, 0);
});

test('photos of an already aborted request are skipped without any image processing', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    const controller = new AbortController();
    controller.abort();

    const { created, failed } = await confirmPhotosBatch({ photos: slowBatch(3), signal: controller.signal });

    assert.equal(created.length, 0);
    assert.equal(failed.length, 3);
    assert.equal(generationCalls.length, 0);
    assert.equal(watermarkLoads, 0);
});

test('photos still queued when the client leaves are skipped, those already processing finish', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    const controller = new AbortController();
    const photos = slowBatch(6);

    const pending = confirmPhotosBatch({ photos, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 8)); // the first 2 are running, 4 are queued
    controller.abort();
    const { created, failed } = await pending;

    assert.equal(created.length, 2);
    assert.equal(failed.length, 4);
    assert.equal(generationCalls.length, 2);
});


// --- Step C4: size source and guard ---

test('confirmPhotosBatch passes the size S3 reported (HEAD) to generateDerivedImages', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    headResult = { size: 4321, contentType: 'image/jpeg' };

    await confirmPhotosBatch({ photos: slowBatch(1) });
    headResult = { size: 1234, contentType: 'image/jpeg' };

    assert.equal(generationCalls[0].options.originalSize, 4321);
});

test('confirmPhotosBatch refuses an original above MAX_ORIGINAL_BYTES before any processing', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    headResult = { size: 150_000_001, contentType: 'image/jpeg' };

    const { created, failed } = await confirmPhotosBatch({ photos: slowBatch(2) });
    headResult = { size: 1234, contentType: 'image/jpeg' };

    assert.equal(created.length, 0);
    assert.equal(failed.length, 2);
    assert.match(failed[0].error, /too large to process/);
    assert.equal(generationCalls.length, 0);
});

test('confirmPhotosBatch accepts an original of exactly MAX_ORIGINAL_BYTES', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    headResult = { size: 150_000_000, contentType: 'image/jpeg' };

    const { created } = await confirmPhotosBatch({ photos: slowBatch(1) });
    headResult = { size: 1234, contentType: 'image/jpeg' };

    assert.equal(created.length, 1);
});

test('confirmPhotosBatch reports a missing original (HEAD 404) in failed, as before', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    headResult = null;

    const { created, failed } = await confirmPhotosBatch({ photos: slowBatch(1) });
    headResult = { size: 1234, contentType: 'image/jpeg' };

    assert.equal(created.length, 0);
    assert.match(failed[0].error, /not found in storage/);
    assert.equal(generationCalls.length, 0);
});


// --- Step C5: attachmentCount / attachmentFilenames (admin DTO only) ---

const makePhoto = (id) => ({ ...fakePhoto, id, key: `uploads/collection-1/p${id}.jpg`, toJSON() { return { ...fakePhoto.toJSON(), id, key: this.key }; } });

const resetAttachmentTracking = () => {
    attachmentFindAllCalls = [];
    currentFindAllPhotos = null;
    currentAttachments = [];
};

test('admin list carries attachmentCount and attachmentFilenames per photo, from a single attachments query', async () => {
    resetAttachmentTracking();
    currentFindAllPhotos = [makePhoto(1), makePhoto(2), makePhoto(3)];
    currentAttachments = [
        { photoId: 1, originalFilename: 'IMG_1.CR2' },
        { photoId: 1, originalFilename: 'IMG_1.xmp' },
        { photoId: 3, originalFilename: 'IMG_3.CR2' },
    ];

    const photos = await getAllPhotosByCollectionId('collection-1');
    currentFindAllPhotos = null;

    assert.deepEqual(photos.map((photo) => [photo.id, photo.attachmentCount, photo.attachmentFilenames]), [
        [1, 2, ['IMG_1.CR2', 'IMG_1.xmp']],
        [2, 0, []],
        [3, 1, ['IMG_3.CR2']],
    ]);
    assert.equal(attachmentFindAllCalls.length, 1, 'no N+1: one attachments query for the whole list');
    assert.deepEqual(attachmentFindAllCalls[0].where, { photoId: [1, 2, 3] });
    assert.deepEqual(attachmentFindAllCalls[0].attributes, ['photoId', 'originalFilename']);
});

test('admin list of an empty collection runs no attachments query', async () => {
    resetAttachmentTracking();
    currentFindAllPhotos = [];

    const photos = await getAllPhotosByCollectionId('collection-1');
    currentFindAllPhotos = null;

    assert.deepEqual(photos, []);
    assert.equal(attachmentFindAllCalls.length, 0);
});

test('admin list keeps every existing field (additive change only)', async () => {
    resetAttachmentTracking();
    const [photo] = await getAllPhotosByCollectionId('collection-1');
    for (const field of ['id', 'collectionId', 'key', 'previewKey', 'thumbnailKey', 'status', 'url', 'thumbnailUrl', 'previewUrl']) {
        assert.ok(field in photo, field);
    }
});

test('client gallery DTO never carries attachment information and runs no attachments query', async () => {
    resetAttachmentTracking();
    currentAttachments = [{ photoId: 'photo-1', originalFilename: 'IMG_1.CR2' }];

    const photos = await getAllClientPhotosByCollectionId('collection-1');

    assert.ok(photos.length > 0);
    for (const photo of photos) {
        assert.equal('attachmentCount' in photo, false);
        assert.equal('attachmentFilenames' in photo, false);
        assert.ok(!JSON.stringify(photo).includes('IMG_1.CR2'));
    }
    assert.equal(attachmentFindAllCalls.length, 0);
});

test('delivered gallery DTO (served to the client once READY) never carries attachment information either', async () => {
    resetAttachmentTracking();
    currentAttachments = [{ photoId: 'photo-1', originalFilename: 'IMG_1.CR2' }];

    const photos = await getDeliveredPhotosByCollectionId('collection-1');

    assert.ok(photos.length > 0);
    for (const photo of photos) {
        assert.equal('attachmentCount' in photo, false);
        assert.equal('attachmentFilenames' in photo, false);
    }
    assert.equal(attachmentFindAllCalls.length, 0);
});

test('getPhotoById (admin) carries the attachment info', async () => {
    resetAttachmentTracking();
    currentFindByPkPhoto = makePhoto(7);
    currentAttachments = [{ photoId: 7, originalFilename: 'IMG_7.CR2' }];

    const photo = await getPhotoById(7);
    currentFindByPkPhoto = fakePhoto;

    assert.equal(photo.attachmentCount, 1);
    assert.deepEqual(photo.attachmentFilenames, ['IMG_7.CR2']);
});

test('confirm returns attachmentCount / attachmentFilenames for the attachments actually saved', async () => {
    currentCollectionStatus = 'SELECTING';
    resetGenerationTracking();
    createdAttachmentData = [];

    const { created, failedAttachments } = await confirmPhotosBatch({
        photos: [{
            collectionId: 'collection-1', key: ORIGINAL_KEY, contentType: 'image/jpeg', size: 10, filename: 'IMG_0099.jpg',
            attachments: [
                { key: 'attachments/collection-1/uuid-IMG_0099.CR2', contentType: 'image/x-canon-cr2', size: 100, filename: 'IMG_0099.CR2' },
                { key: 'attachments/collection-1/uuid-.DS_Store', contentType: '', size: 100, filename: '.DS_Store' },
            ],
        }],
    });

    assert.equal(failedAttachments.length, 1);
    assert.equal(created[0].attachmentCount, 1);
    assert.deepEqual(created[0].attachmentFilenames, ['IMG_0099.CR2']);
});
