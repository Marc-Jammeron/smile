import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// collection.service.js imports db.repository.js (real Postgres connection as a module
// side effect) and photo.service.js (which itself imports db/s3/image-processing), so
// everything needs mocking before import, same approach as photo.service.test.js.
let currentCollection = null;
let currentSelectedPhotos = [];
let currentDeliveredPhotos = [];
let currentNonDeliveredPhotos = [];
let currentDeliveredCount = 0;
let currentUnprocessedDeliveredCount = 0;
let currentProcessingRows = [];
let destroyedWhere = null;
let collectionUpdateCalls = [];
let deletedS3Keys = [];
let transactionInvoked = false;
let currentAttachmentsByPhotoId = {};
let currentCollectionPhotos = [];
let destroyedCollectionWhere = null;
let deletedPrefixes = [];
let failingS3Key = null;
let photoFindAllOptions = [];
let collectionFindOptions = [];
let createdCollectionData = null;

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Collection: {
            create: async (data) => {
                createdCollectionData = data;
                return { id: 'new-col', ...data };
            },
            findByPk: async (_id, options) => {
                collectionFindOptions.push(options);
                return currentCollection;
            },
            findAll: async (options) => {
                collectionFindOptions.push(options);
                return [];
            },
            destroy: async ({ where }) => {
                destroyedCollectionWhere = where;
                return 1;
            },
            update: async (data, options) => {
                collectionUpdateCalls.push({ data, options });
                if (currentCollection) {
                    currentCollection = { ...currentCollection, ...data };
                }
                return [1];
            },
        },
        Photo: {
            findAll: async (options) => {
                const { where } = options;
                photoFindAllOptions.push(options);
                if (options.raw) return currentProcessingRows;
                if (!('status' in where)) return currentCollectionPhotos;
                if (where.status === 'SELECTED') return currentSelectedPhotos;
                if (where.status === 'DELIVERED') return currentDeliveredPhotos;
                return currentNonDeliveredPhotos; // { [Op.ne]: 'DELIVERED' } case
            },
            // The processingStatus filter is the "delivered but not DONE" guard of markCollectionAsReady.
            count: async ({ where }) => ('processingStatus' in where ? currentUnprocessedDeliveredCount : currentDeliveredCount),
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
            fn: (name, column) => ({ fn: name, column }),
            col: (name) => ({ col: name }),
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
        deleteObject: async (key) => {
            if (key === failingS3Key) throw new Error('S3 unavailable');
            deletedS3Keys.push(key);
            return true;
        },
        deleteByPrefix: async (prefix) => {
            deletedPrefixes.push(prefix);
            return 0;
        },
    },
});

mock.module('../src/services/image-processing.service.js', {
    namedExports: {
        generateDerivedImages: async () => ({ thumbnailKey: 'thumb', previewKey: 'preview' }),
    },
});

// The ZIP side (rows, S3 files, worker) is tested in collection-archive.service.test.js:
// here only the calls made by the collection lifecycle are recorded.
let archiveCalls = [];
let failingArchiveCall = null;
const recordArchiveCall = (name) => async (...args) => {
    archiveCalls.push([name, ...args]);
    if (failingArchiveCall === name) throw new Error(`${name} failed`);
};
mock.module('../src/services/collection-archive.service.js', {
    namedExports: {
        refreshArchive: recordArchiveCall('refreshArchive'),
        discardArchives: recordArchiveCall('discardArchives'),
        deleteArchivesForCollection: recordArchiveCall('deleteArchivesForCollection'),
    },
});

const { markCollectionAsReady, getAllCollections, getCollectionById, createCollection, updateCollection, pickCollectionFields, UPDATABLE_COLLECTION_FIELDS, ALLOWED_STATUS_TRANSITIONS, deleteCollection, CLIENT_MESSAGE_MAX_LENGTH, getCollectionProcessingStatus } = await import('../src/services/collection.service.js');

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

test('markCollectionAsReady generates a client access token for a collection that never went through SELECTING', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING', accessToken: null };
    currentDeliveredCount = 3;
    currentNonDeliveredPhotos = [];
    collectionUpdateCalls = [];
    deletedS3Keys = [];

    const updated = await markCollectionAsReady('col-1');

    assert.equal(collectionUpdateCalls.length, 1);
    assert.equal(collectionUpdateCalls[0].data.status, 'READY');
    assert.ok(collectionUpdateCalls[0].data.accessToken, 'expected an access token for a collection that never went through SELECTING');
    assert.equal(updated.status, 'READY');
});

test('markCollectionAsReady keeps the existing access token of a collection that went through SELECTING', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING', accessToken: 'existing-token' };
    currentDeliveredCount = 1;
    currentNonDeliveredPhotos = [];
    collectionUpdateCalls = [];

    await markCollectionAsReady('col-1');

    assert.equal('accessToken' in collectionUpdateCalls[0].data, false);
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



test('createCollection accepts the DRAFT and EDITING statuses and defaults when no status is given', async () => {
    for (const status of ['DRAFT', 'EDITING']) {
        createdCollectionData = null;
        await createCollection({ name: 'Mariage', clientName: 'Dupont', status });
        assert.equal(createdCollectionData.status, status);
    }
    createdCollectionData = null;
    await createCollection({ name: 'Mariage', clientName: 'Dupont' });
    assert.ok(createdCollectionData, 'expected the collection to be created without an explicit status');
});

test('createCollection refuses SELECTING, READY and ARCHIVED with a 400 and creates nothing', async () => {
    for (const status of ['SELECTING', 'READY', 'ARCHIVED', 'NOPE']) {
        createdCollectionData = null;
        await assert.rejects(
            () => createCollection({ name: 'Mariage', clientName: 'Dupont', status }),
            (error) => {
                assert.equal(error.status, 400);
                return true;
            }
        );
        assert.equal(createdCollectionData, null, `${status} must not reach the database`);
    }
});

test('createCollection only keeps the whitelisted fields (no access token or viewed flag from the client)', async () => {
    createdCollectionData = null;
    await createCollection({ name: 'Mariage', clientName: 'Dupont', maxPhotos: 5, accessToken: 'forged', accessTokenRevokedAt: null, viewedByCustomer: true, id: 'forged-id' });
    assert.deepEqual(createdCollectionData, { name: 'Mariage', clientName: 'Dupont', maxPhotos: 5 });
});

test('pickCollectionFields drops unknown and server-managed fields on update', () => {
    const picked = pickCollectionFields({ status: 'EDITING', clientMessage: 'Hi', finalMessage: 'Bye', accessToken: 'x', accessTokenExpiresAt: 'x', viewedByCustomer: true }, UPDATABLE_COLLECTION_FIELDS);
    assert.deepEqual(picked, { status: 'EDITING', clientMessage: 'Hi', finalMessage: 'Bye' });
    assert.deepEqual(pickCollectionFields(undefined, UPDATABLE_COLLECTION_FIELDS), {});
});

test('updateCollection refuses forbidden status transitions with a 400 and writes nothing', async () => {
    const forbidden = [
        ['DRAFT', 'READY'], ['SELECTING', 'READY'], ['EDITING', 'READY'],
        ['EDITING', 'DRAFT'], ['READY', 'EDITING'], ['READY', 'SELECTING'],
        ['ARCHIVED', 'DRAFT'], ['ARCHIVED', 'READY'], ['DRAFT', 'NOPE'],
    ];
    for (const [from, to] of forbidden) {
        currentCollection = { id: 'c1', status: from };
        collectionUpdateCalls = [];
        await assert.rejects(
            () => updateCollection('c1', { status: to }),
            (error) => {
                assert.equal(error.status, 400);
                return true;
            },
            `${from} -> ${to} should be refused`
        );
        assert.equal(collectionUpdateCalls.length, 0, `${from} -> ${to} must not reach the database`);
    }
});

test('updateCollection accepts every transition listed in ALLOWED_STATUS_TRANSITIONS', async () => {
    for (const [from, targets] of Object.entries(ALLOWED_STATUS_TRANSITIONS)) {
        for (const to of targets) {
            currentCollection = { id: 'c1', status: from, accessToken: 'token' };
            collectionUpdateCalls = [];
            await updateCollection('c1', { status: to });
            assert.equal(collectionUpdateCalls[0].data.status, to, `${from} -> ${to} should be accepted`);
        }
    }
});

test('updateCollection treats a status equal to the current one as a no-op change, even for ARCHIVED', async () => {
    currentCollection = { id: 'c1', status: 'ARCHIVED' };
    collectionUpdateCalls = [];
    await updateCollection('c1', { status: 'ARCHIVED' });
    assert.equal(collectionUpdateCalls.length, 1);
});

test('updateCollection returns null when the collection does not exist and a status is requested', async () => {
    currentCollection = null;
    collectionUpdateCalls = [];
    assert.equal(await updateCollection('missing', { status: 'EDITING' }), null);
    assert.equal(collectionUpdateCalls.length, 0);
});

test('updateCollection generates an access token when a DRAFT collection enters SELECTING', async () => {
    currentCollection = { id: 'c1', status: 'DRAFT', accessToken: null };
    collectionUpdateCalls = [];
    await updateCollection('c1', { status: 'SELECTING' });
    assert.ok(collectionUpdateCalls[0].data.accessToken);
});

test('updateCollection trims clientMessage and stores an empty one as null', async () => {
    currentCollection = { id: 'c1', status: 'SELECTING' };
    collectionUpdateCalls = [];

    await updateCollection('c1', { clientMessage: '  Bonjour  ' });
    assert.equal(collectionUpdateCalls[0].data.clientMessage, 'Bonjour');

    await updateCollection('c1', { clientMessage: '   ' });
    assert.equal(collectionUpdateCalls[1].data.clientMessage, null);

    await updateCollection('c1', { clientMessage: null });
    assert.equal(collectionUpdateCalls[2].data.clientMessage, null);
});

test('updateCollection trims finalMessage, stores an empty one as null and rejects one over the limit', async () => {
    currentCollection = { id: 'c1', status: 'READY' };
    collectionUpdateCalls = [];

    await updateCollection('c1', { finalMessage: '  Merci !  ' });
    assert.equal(collectionUpdateCalls[0].data.finalMessage, 'Merci !');
    assert.equal('clientMessage' in collectionUpdateCalls[0].data, false);

    await updateCollection('c1', { finalMessage: '   ' });
    assert.equal(collectionUpdateCalls[1].data.finalMessage, null);

    await assert.rejects(
        () => updateCollection('c1', { finalMessage: 'a'.repeat(CLIENT_MESSAGE_MAX_LENGTH + 1) }),
        (error) => error.status === 400
    );
    assert.equal(collectionUpdateCalls.length, 2);
});

test('updateCollection rejects a clientMessage longer than the limit with a 400', async () => {
    currentCollection = { id: 'c1', status: 'SELECTING' };
    collectionUpdateCalls = [];

    await assert.rejects(
        () => updateCollection('c1', { clientMessage: 'a'.repeat(CLIENT_MESSAGE_MAX_LENGTH + 1) }),
        (error) => {
            assert.equal(error.status, 400);
            return true;
        }
    );
    assert.equal(collectionUpdateCalls.length, 0);
});

test('updateCollection leaves clientMessage untouched when it is not in the payload', async () => {
    currentCollection = { id: 'c1', status: 'SELECTING' };
    collectionUpdateCalls = [];

    await updateCollection('c1', { name: 'New name' });
    assert.equal('clientMessage' in collectionUpdateCalls[0].data, false);
});


test('deleteCollection removes every S3 object, sweeps the prefixes, then deletes the row', async () => {
    archiveCalls = [];
    currentCollection = { id: 'c1', status: 'READY' };
    currentCollectionPhotos = [
        { id: 1, key: 'uploads/c1/a.jpg', thumbnailKey: 'uploads/c1/a-thumb.jpg', previewKey: 'uploads/c1/a-preview.jpg' },
        { id: 2, key: 'uploads/c1/b.jpg', thumbnailKey: null, previewKey: null },
    ];
    currentAttachmentsByPhotoId = { 1: [{ s3Key: 'attachments/c1/a.cr2' }] };
    deletedS3Keys = [];
    deletedPrefixes = [];
    destroyedCollectionWhere = null;
    failingS3Key = null;

    assert.equal(await deleteCollection('c1'), true);

    assert.deepEqual(deletedS3Keys.sort(), [
        'attachments/c1/a.cr2',
        'uploads/c1/a-preview.jpg',
        'uploads/c1/a-thumb.jpg',
        'uploads/c1/a.jpg',
        'uploads/c1/b.jpg',
    ]);
    assert.deepEqual(deletedPrefixes, ['uploads/c1/', 'attachments/c1/']);
    assert.deepEqual(destroyedCollectionWhere, { id: 'c1' });
    assert.deepEqual(archiveCalls, [['deleteArchivesForCollection', 'c1']], 'the pre-generated ZIPs go with the collection');
});

test('deleteCollection returns false and touches nothing when the collection does not exist', async () => {
    currentCollection = null;
    deletedS3Keys = [];
    deletedPrefixes = [];
    destroyedCollectionWhere = null;

    assert.equal(await deleteCollection('missing'), false);
    assert.deepEqual(deletedS3Keys, []);
    assert.deepEqual(deletedPrefixes, []);
    assert.equal(destroyedCollectionWhere, null);
});

test('deleteCollection keeps the DB row when an S3 deletion fails, so it can be retried', async () => {
    currentCollection = { id: 'c1', status: 'READY' };
    currentCollectionPhotos = [{ id: 1, key: 'uploads/c1/a.jpg', thumbnailKey: null, previewKey: null }];
    currentAttachmentsByPhotoId = {};
    destroyedCollectionWhere = null;
    failingS3Key = 'uploads/c1/a.jpg';

    await assert.rejects(() => deleteCollection('c1'), /S3 unavailable/);
    assert.equal(destroyedCollectionWhere, null);
    failingS3Key = null;
});


const POSITION_ORDER = [['position', 'ASC'], ['id', 'ASC']];



test('getCollectionById and getAllCollections order the included photos by position', async () => {
    currentCollection = { id: 'col-1' };
    collectionFindOptions = [];

    await getCollectionById('col-1');
    await getAllCollections();

    for (const { order } of collectionFindOptions) {
        assert.deepEqual(order.map(([, column, direction]) => [column, direction]), POSITION_ORDER);
    }
    assert.equal(collectionFindOptions.length, 2);
});

test('markCollectionAsReady throws 409 while delivered photos are not all processed', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING', accessToken: null };
    currentDeliveredCount = 3;
    currentUnprocessedDeliveredCount = 1;
    transactionInvoked = false;
    collectionUpdateCalls = [];

    await assert.rejects(
        () => markCollectionAsReady('col-1'),
        (error) => {
            assert.equal(error.status, 409);
            assert.match(error.message, /traitées/);
            return true;
        }
    );
    assert.equal(transactionInvoked, false, 'nothing may be deleted while photos are still processed');
    assert.equal(collectionUpdateCalls.length, 0);
    currentUnprocessedDeliveredCount = 0;
});

test('markCollectionAsReady goes through once every delivered photo is processed', async () => {
    currentCollection = { id: 'col-1', name: 'Mariage Dupont', status: 'EDITING', accessToken: 'token' };
    currentDeliveredCount = 3;
    currentUnprocessedDeliveredCount = 0;
    currentNonDeliveredPhotos = [];

    await markCollectionAsReady('col-1');

    assert.ok(transactionInvoked);
});

test('getCollectionProcessingStatus returns the counters (zero-filled), the status and sendRequestedAt', async () => {
    const requestedAt = new Date('2026-11-16T10:00:00Z');
    currentCollection = { id: 'col-1', status: 'DRAFT', sendRequestedAt: requestedAt };
    currentProcessingRows = [
        { processingStatus: 'DONE', count: '12' },
        { processingStatus: 'QUEUED', count: '3' },
        { processingStatus: 'FAILED', count: '1' },
    ];
    photoFindAllOptions = [];

    const status = await getCollectionProcessingStatus('col-1');

    assert.deepEqual(status, { queued: 3, processing: 0, done: 12, failed: 1, status: 'DRAFT', sendRequestedAt: requestedAt });
    // Soft-deleted photos must not count.
    const { where } = photoFindAllOptions.at(-1);
    assert.equal(where.collectionId, 'col-1');
    assert.ok(Object.getOwnPropertySymbols(where.status).length === 1, 'ARCHIVED photos are excluded');
});

test('getCollectionProcessingStatus returns null for an unknown collection', async () => {
    currentCollection = null;
    assert.equal(await getCollectionProcessingStatus('missing'), null);
});

// --- pre-generated ZIPs follow the lifecycle ---------------------------------------------------

const resetArchiveCalls = () => {
    archiveCalls = [];
    failingArchiveCall = null;
};

test('a collection entering EDITING queues the retouching ZIP', async () => {
    resetArchiveCalls();
    currentCollection = { id: 'col-1', status: 'SELECTING', accessToken: 'tok' };
    await updateCollection('col-1', { status: 'EDITING' });
    assert.deepEqual(archiveCalls, [['refreshArchive', 'col-1', 'SELECTION_HD']]);
});

test('a collection that is already EDITING does not requeue the ZIP on a no-op status change', async () => {
    resetArchiveCalls();
    currentCollection = { id: 'col-1', status: 'EDITING' };
    await updateCollection('col-1', { status: 'EDITING' });
    assert.deepEqual(archiveCalls, []);
});

test('other status changes touch no ZIP', async () => {
    resetArchiveCalls();
    currentCollection = { id: 'col-1', status: 'DRAFT' };
    await updateCollection('col-1', { status: 'SELECTING' });
    await updateCollection('col-1', { name: 'Renamed' });
    assert.deepEqual(archiveCalls, []);
});

test('archiving a collection removes its ZIPs, and repeating the request cleans up again', async () => {
    resetArchiveCalls();
    currentCollection = { id: 'col-1', status: 'READY' };
    await updateCollection('col-1', { status: 'ARCHIVED' });
    assert.deepEqual(archiveCalls, [['discardArchives', 'col-1']]);

    resetArchiveCalls();
    currentCollection = { id: 'col-1', status: 'ARCHIVED' };
    await updateCollection('col-1', { status: 'ARCHIVED' });
    assert.deepEqual(archiveCalls, [['discardArchives', 'col-1']]);
});

test('marking a collection READY drops the retouching ZIP, then queues the delivered one once the purge is done', async () => {
    resetArchiveCalls();
    currentCollection = { id: 'col-1', name: 'Mariage', status: 'EDITING' };
    currentDeliveredCount = 2;
    currentUnprocessedDeliveredCount = 0;
    currentNonDeliveredPhotos = [{ id: 1, key: 'uploads/col-1/a.jpg', thumbnailKey: null, previewKey: null, status: 'PENDING' }];
    deletedS3Keys = [];
    const callsWhenOriginalsWereDeleted = [];
    const original = deletedS3Keys.push;
    deletedS3Keys.push = function (...keys) { callsWhenOriginalsWereDeleted.push([...archiveCalls]); return original.apply(this, keys); };

    await markCollectionAsReady('col-1');

    assert.deepEqual(archiveCalls, [['discardArchives', 'col-1', ['SELECTION_HD']], ['refreshArchive', 'col-1', 'DELIVERED']]);
    assert.deepEqual(callsWhenOriginalsWereDeleted, [[]], 'the ZIPs are only touched after the purge of the originals');
});


test('deleting a collection whose ZIP cleanup fails keeps the row, so it can be retried', async () => {
    resetArchiveCalls();
    currentCollection = { id: 'c1', status: 'READY' };
    currentCollectionPhotos = [];
    currentAttachmentsByPhotoId = {};
    destroyedCollectionWhere = null;
    failingArchiveCall = 'deleteArchivesForCollection';
    await assert.rejects(() => deleteCollection('c1'), /deleteArchivesForCollection failed/);
    assert.equal(destroyedCollectionWhere, null);
    failingArchiveCall = null;
});
