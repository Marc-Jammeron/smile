import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UniqueConstraintError } from 'sequelize';

// collection-archive.service.js imports db.repository.js (real Postgres connection as a
// module side effect), s3 and photo.service: all mocked before import. The CollectionArchive
// table is a small in-memory fake so the tests assert on the resulting rows, not on calls.
let rows = [];
let selectedPhotos = [];
let deliveredPhotos = [];
let attachments = [];
let deletedPrefixes = [];
let deletedByPrefixCount = 0;
let signedDownloads = [];
let createRace = false;
let nextId = 1;
let currentCollection = null;
let photoCollections = {};   // photoId -> collectionId
let ensureShouldFail = false;
let missingKeys = new Set();

const matches = (row, where = {}) => Object.entries(where).every(([field, value]) => row[field] === value);

const makeRow = (data) => {
    const row = {
        id: `archive-${nextId++}`,
        status: 'QUEUED',
        s3Key: null,
        builtFingerprint: null,
        sizeBytes: null,
        photoCount: null,
        attempts: 0,
        startedAt: null,
        heartbeatAt: null,
        error: null,
        ...data,
    };
    row.update = async (values) => Object.assign(row, values);
    return row;
};

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Collection: {
            findByPk: async () => currentCollection,
        },
        Photo: {
            findAll: async ({ where }) => where.id.filter((id) => id in photoCollections).map((id) => ({ collectionId: photoCollections[id] })),
        },
        CollectionArchive: {
            findOne: async ({ where }) => rows.find((row) => matches(row, where)) ?? null,
            findAll: async ({ where }) => rows.filter((row) => matches(row, where)),
            create: async (data) => {
                if (createRace) {
                    // Another caller created the row between our read and our insert.
                    createRace = false;
                    rows.push(makeRow({ ...data, status: 'QUEUED' }));
                    throw new UniqueConstraintError({ message: 'duplicate' });
                }
                const row = makeRow(data);
                rows.push(row);
                return row;
            },
            update: async (values, { where }) => {
                const targets = rows.filter((row) => matches(row, where));
                targets.forEach((row) => Object.assign(row, values));
                return [targets.length];
            },
            destroy: async ({ where }) => {
                const before = rows.length;
                rows = rows.filter((row) => !matches(row, where));
                return before - rows.length;
            },
        },
        sequelize: {
            transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
        },
    },
});

mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        deleteByPrefix: async (prefix) => {
            deletedPrefixes.push(prefix);
            return deletedByPrefixCount;
        },
        objectExists: async (key) => !missingKeys.has(key),
        getSignedArchiveDownloadUrl: async (key, filename) => {
            signedDownloads.push({ key, filename });
            return `https://s3.test/${key}?download=${filename}`;
        },
    },
});

mock.module('../src/services/photo.service.js', {
    namedExports: {
        getSelectedPhotosForCollection: async () => selectedPhotos,
        getDeliveredPhotosForZip: async () => deliveredPhotos,
        getAttachmentsForPhotos: async (photoIds) => attachments.filter((attachment) => photoIds.includes(attachment.photoId)),
        getPhotoDownloadFilename: (photo) => photo.originalFilename,
    },
});

const {
    computeFingerprint, buildArchivePlan, buildArchiveS3Key, ensureArchive, getArchiveStatus, getArchivesStatus,
    resolveArchiveDownload, retryArchive, deleteArchive, deleteArchivesForCollection,
    refreshArchive, refreshSelectionArchivesForPhotos, discardArchives, requestSelectionHdDownload, requestDeliveredDownload,
    toDownloadResponse, getClientArchiveInfo, getCollectionArchives,
} = await import('../src/services/collection-archive.service.js');

const COLLECTION = 'collection-1';

const photo = (id, extra = {}) => ({ id, key: `uploads/${COLLECTION}/${id}.jpg`, originalFilename: `IMG_${id}.jpg`, ...extra });
const attachment = (photoId, name) => ({ photoId, s3Key: `attachments/${COLLECTION}/${name}`, originalFilename: name });

beforeEach(() => {
    rows = [];
    selectedPhotos = [photo(1), photo(2)];
    deliveredPhotos = [photo(1), photo(2), photo(3)];
    attachments = [];
    deletedPrefixes = [];
    deletedByPrefixCount = 0;
    signedDownloads = [];
    createRace = false;
    nextId = 1;
    currentCollection = { id: COLLECTION, name: 'Mariage Léa & Hugo', status: 'EDITING' };
    photoCollections = {};
    ensureShouldFail = false;
    missingKeys = new Set();
});

const markDone = async (kind = 'SELECTION_HD') => {
    const { archive } = await ensureArchive(COLLECTION, kind);
    Object.assign(archive, { status: 'DONE', builtFingerprint: archive.fingerprint, s3Key: `archives/${COLLECTION}/${kind}-old.zip`, sizeBytes: '1500', photoCount: 2 });
    return archive;
};

// --- fingerprint and plan --------------------------------------------------------------

test('the fingerprint does not depend on the order of the entries', () => {
    const a = computeFingerprint([{ photoId: 1, key: 'a' }, { photoId: 2, key: 'b' }]);
    const b = computeFingerprint([{ photoId: 2, key: 'b' }, { photoId: 1, key: 'a' }]);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
});

test('the fingerprint changes when a photo or a key changes', () => {
    const base = computeFingerprint([{ photoId: 1, key: 'a' }]);
    assert.notEqual(base, computeFingerprint([{ photoId: 1, key: 'b' }]));
    assert.notEqual(base, computeFingerprint([{ photoId: 2, key: 'a' }]));
    assert.notEqual(base, computeFingerprint([{ photoId: 1, key: 'a' }, { photoId: 2, key: 'c' }]));
});

test('the SELECTION_HD plan uses the JPEG of the selected photos', async () => {
    const { entries } = await buildArchivePlan(COLLECTION, 'SELECTION_HD');
    assert.deepEqual(entries, [
        { photoId: 1, key: `uploads/${COLLECTION}/1.jpg`, name: 'IMG_1.jpg' },
        { photoId: 2, key: `uploads/${COLLECTION}/2.jpg`, name: 'IMG_2.jpg' },
    ]);
});

test('the SELECTION_HD plan replaces the JPEG by the RAW/XMP attachments of a photo', async () => {
    attachments = [attachment(1, 'IMG_1.CR2'), attachment(1, 'IMG_1.xmp')];
    const { entries } = await buildArchivePlan(COLLECTION, 'SELECTION_HD');
    assert.deepEqual(entries.map(({ name }) => name), ['IMG_1.CR2', 'IMG_1.xmp', 'IMG_2.jpg']);
    assert.ok(!entries.some(({ key }) => key.endsWith('/1.jpg')));
});

test('the SELECTION_HD fingerprint changes when an attachment is added or removed', async () => {
    const withoutAttachment = (await buildArchivePlan(COLLECTION, 'SELECTION_HD')).fingerprint;
    attachments = [attachment(1, 'IMG_1.CR2')];
    const withAttachment = (await buildArchivePlan(COLLECTION, 'SELECTION_HD')).fingerprint;
    assert.notEqual(withAttachment, withoutAttachment);
    attachments = [];
    assert.equal((await buildArchivePlan(COLLECTION, 'SELECTION_HD')).fingerprint, withoutAttachment);
});

test('the DELIVERED plan lists the delivered photos only', async () => {
    const { entries } = await buildArchivePlan(COLLECTION, 'DELIVERED');
    assert.deepEqual(entries.map(({ photoId }) => photoId), [1, 2, 3]);
});

test('the S3 key carries the kind and a short fingerprint, so a new ZIP never overwrites the old one', () => {
    const key = buildArchiveS3Key(COLLECTION, 'DELIVERED', 'abcdef0123456789abcdef');
    assert.equal(key, `archives/${COLLECTION}/DELIVERED-abcdef0123456789.zip`);
});

// --- ensureArchive ---------------------------------------------------------------------

test('ensureArchive queues a new archive when none exists', async () => {
    const { archive, queued } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(queued, true);
    assert.equal(rows.length, 1);
    assert.equal(archive.status, 'QUEUED');
    assert.equal(archive.fingerprint, (await buildArchivePlan(COLLECTION, 'SELECTION_HD')).fingerprint);
    assert.equal(archive.builtFingerprint, null);
});

test('ensureArchive is idempotent while the archive is waiting', async () => {
    await ensureArchive(COLLECTION, 'SELECTION_HD');
    const second = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(second.queued, false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'QUEUED');
});

test('ensureArchive does nothing when the stored ZIP matches the expected content', async () => {
    await markDone();
    const { queued, archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(queued, false);
    assert.equal(archive.status, 'DONE');
    assert.equal(archive.s3Key, `archives/${COLLECTION}/SELECTION_HD-old.zip`);
});

test('ensureArchive queues again when the content changed, and keeps the old file for download', async () => {
    const done = await markDone();
    attachments = [attachment(1, 'IMG_1.CR2')];
    const { queued, archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(queued, true);
    assert.equal(archive.status, 'QUEUED');
    assert.notEqual(archive.fingerprint, done.builtFingerprint);
    assert.equal(archive.builtFingerprint, done.builtFingerprint);
    assert.equal(archive.s3Key, `archives/${COLLECTION}/SELECTION_HD-old.zip`);
    assert.equal(archive.attempts, 0);
});

test('ensureArchive during a build only moves the target: the worker notices it at the end', async () => {
    const { archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    archive.status = 'PROCESSING';
    attachments = [attachment(1, 'IMG_1.CR2')];
    const { queued } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(queued, false);
    assert.equal(rows[0].status, 'PROCESSING');
    assert.equal(rows[0].fingerprint, (await buildArchivePlan(COLLECTION, 'SELECTION_HD')).fingerprint);
});

test('ensureArchive leaves a FAILED archive alone while its content is the same', async () => {
    const { archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    Object.assign(archive, { status: 'FAILED', attempts: 3, error: 'boom' });
    const { queued } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(queued, false);
    assert.equal(rows[0].status, 'FAILED');
    assert.equal(rows[0].attempts, 3);
});

test('ensureArchive gives a FAILED archive a new chance when its content changed', async () => {
    const { archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    Object.assign(archive, { status: 'FAILED', attempts: 3, error: 'boom' });
    attachments = [attachment(2, 'IMG_2.CR2')];
    const { queued } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(queued, true);
    assert.equal(rows[0].status, 'QUEUED');
    assert.equal(rows[0].attempts, 0);
    assert.equal(rows[0].error, null);
});

test('ensureArchive queues each kind independently', async () => {
    await ensureArchive(COLLECTION, 'SELECTION_HD');
    await ensureArchive(COLLECTION, 'DELIVERED');
    assert.deepEqual(rows.map(({ kind }) => kind).sort(), ['DELIVERED', 'SELECTION_HD']);
});

test('ensureArchive survives two callers creating the row at the same time', async () => {
    createRace = true;
    const { archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(rows.length, 1);
    assert.equal(archive.status, 'QUEUED');
});

test('ensureArchive with nothing to archive removes the stored ZIP and queues nothing', async () => {
    await markDone('DELIVERED');
    deliveredPhotos = [];
    deletedByPrefixCount = 1;
    const { archive, queued } = await ensureArchive(COLLECTION, 'DELIVERED');
    assert.equal(archive, null);
    assert.equal(queued, false);
    assert.equal(rows.length, 0);
    assert.deepEqual(deletedPrefixes, [`archives/${COLLECTION}/DELIVERED-`]);
});

test('ensureArchive refuses an unknown kind', async () => {
    await assert.rejects(() => ensureArchive(COLLECTION, 'WHATEVER'), /Unknown archive kind/);
    assert.equal(rows.length, 0);
});

// --- reading and download --------------------------------------------------------------

test('getArchiveStatus exposes the size as a number and hides the S3 key', async () => {
    await markDone();
    const status = await getArchiveStatus(COLLECTION, 'SELECTION_HD');
    assert.deepEqual(status, { kind: 'SELECTION_HD', status: 'DONE', sizeBytes: 1500, photoCount: 2, error: null });
});

test('getArchiveStatus only reports the error of a FAILED archive', async () => {
    const { archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    archive.error = 'previous failure';
    assert.equal((await getArchiveStatus(COLLECTION, 'SELECTION_HD')).error, null);
    archive.status = 'FAILED';
    assert.equal((await getArchiveStatus(COLLECTION, 'SELECTION_HD')).error, 'previous failure');
});

test('getArchivesStatus returns both kinds, null for the one that does not exist', async () => {
    await ensureArchive(COLLECTION, 'DELIVERED');
    const statuses = await getArchivesStatus(COLLECTION);
    assert.equal(statuses.SELECTION_HD, null);
    assert.equal(statuses.DELIVERED.status, 'QUEUED');
});

test('resolveArchiveDownload answers READY with a presigned URL when the ZIP is up to date', async () => {
    await markDone('DELIVERED');
    const result = await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'mariage.zip');
    assert.equal(result.state, 'READY');
    assert.equal(result.url, `https://s3.test/archives/${COLLECTION}/DELIVERED-old.zip?download=mariage.zip`);
    assert.deepEqual(signedDownloads, [{ key: `archives/${COLLECTION}/DELIVERED-old.zip`, filename: 'mariage.zip' }]);
});

test('resolveArchiveDownload rebuilds a ZIP whose file vanished from the bucket instead of handing out a dead link', async () => {
    const done = await markDone('DELIVERED');
    missingKeys.add(done.s3Key);
    const result = await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'mariage.zip');
    assert.deepEqual(result, { state: 'PENDING', status: 'QUEUED' });
    assert.equal(signedDownloads.length, 0, 'no URL is signed for a file that is not there');
    assert.equal(rows[0].status, 'QUEUED');
    assert.equal(rows[0].s3Key, null);
    assert.equal(rows[0].builtFingerprint, null);
    assert.equal(rows[0].attempts, 0);
});

test('resolveArchiveDownload keeps serving a ZIP that is in the bucket', async () => {
    await markDone('DELIVERED');
    assert.equal((await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'mariage.zip')).state, 'READY');
    assert.equal(rows[0].status, 'DONE');
});

test('resolveArchiveDownload answers PENDING and queues the archive when it is missing (safety net)', async () => {
    const result = await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'mariage.zip');
    assert.deepEqual(result, { state: 'PENDING', status: 'QUEUED' });
    assert.equal(rows.length, 1);
    assert.equal(signedDownloads.length, 0);
});

test('resolveArchiveDownload answers PENDING, not the old file, when the ZIP is stale', async () => {
    await markDone('DELIVERED');
    deliveredPhotos = [photo(1)];
    const result = await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'mariage.zip');
    assert.deepEqual(result, { state: 'PENDING', status: 'QUEUED' });
    assert.equal(signedDownloads.length, 0);
});

test('resolveArchiveDownload answers PENDING while the ZIP is being built', async () => {
    const { archive } = await ensureArchive(COLLECTION, 'DELIVERED');
    archive.status = 'PROCESSING';
    assert.deepEqual(await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'x.zip'), { state: 'PENDING', status: 'PROCESSING' });
});

test('resolveArchiveDownload answers FAILED without restarting the build', async () => {
    const { archive } = await ensureArchive(COLLECTION, 'DELIVERED');
    Object.assign(archive, { status: 'FAILED', attempts: 3 });
    assert.deepEqual(await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'x.zip'), { state: 'FAILED' });
    assert.equal(rows[0].status, 'FAILED');
});

test('resolveArchiveDownload answers EMPTY when there is nothing to archive', async () => {
    deliveredPhotos = [];
    assert.deepEqual(await resolveArchiveDownload(COLLECTION, 'DELIVERED', 'x.zip'), { state: 'EMPTY' });
});

// --- retry and cleanup -----------------------------------------------------------------

test('retryArchive puts a FAILED archive back in the queue with a fresh attempt counter', async () => {
    const { archive } = await ensureArchive(COLLECTION, 'SELECTION_HD');
    Object.assign(archive, { status: 'FAILED', attempts: 3, error: 'boom' });
    const retried = await retryArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(retried.status, 'QUEUED');
    assert.equal(retried.attempts, 0);
    assert.equal(retried.error, null);
});

test('retryArchive ignores an archive that is not FAILED, or missing', async () => {
    assert.equal(await retryArchive(COLLECTION, 'SELECTION_HD'), null);
    await ensureArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(await retryArchive(COLLECTION, 'SELECTION_HD'), null);
    assert.equal(rows[0].status, 'QUEUED');
});

test('deleteArchive removes the files of that kind from S3, then the row', async () => {
    await ensureArchive(COLLECTION, 'SELECTION_HD');
    await ensureArchive(COLLECTION, 'DELIVERED');
    await deleteArchive(COLLECTION, 'SELECTION_HD');
    assert.deepEqual(deletedPrefixes, [`archives/${COLLECTION}/SELECTION_HD-`]);
    assert.deepEqual(rows.map(({ kind }) => kind), ['DELIVERED']);
});

test('deleteArchivesForCollection removes every ZIP of the collection and its rows', async () => {
    await ensureArchive(COLLECTION, 'SELECTION_HD');
    await ensureArchive(COLLECTION, 'DELIVERED');
    await deleteArchivesForCollection(COLLECTION);
    assert.deepEqual(deletedPrefixes, [`archives/${COLLECTION}/`]);
    assert.equal(rows.length, 0);
});

test('a failing S3 cleanup keeps the rows, so the cleanup can be retried', async () => {
    await ensureArchive(COLLECTION, 'DELIVERED');
    const s3 = (await import('../src/repository/s3.repository.js')).default;
    const original = s3.deleteByPrefix;
    s3.deleteByPrefix = async () => { throw new Error('S3 down'); };
    try {
        await assert.rejects(() => deleteArchivesForCollection(COLLECTION), /S3 down/);
    } finally {
        s3.deleteByPrefix = original;
    }
    assert.equal(rows.length, 1);
});

// --- triggers ---------------------------------------------------------------------------------------

test('refreshArchive queues the retouching ZIP while the collection is EDITING', async () => {
    await refreshArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'SELECTION_HD');
});

test('refreshArchive queues the delivered ZIP while the collection is READY', async () => {
    currentCollection = { id: COLLECTION, status: 'READY' };
    await refreshArchive(COLLECTION, 'DELIVERED');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'DELIVERED');
});

test('refreshArchive does nothing when the collection is not in the status where that ZIP is wanted', async () => {
    currentCollection = { id: COLLECTION, status: 'EDITING' };
    await refreshArchive(COLLECTION, 'DELIVERED'); // delivered ZIPs only exist once READY
    currentCollection = { id: COLLECTION, status: 'READY' };
    await refreshArchive(COLLECTION, 'SELECTION_HD'); // the originals are gone
    currentCollection = { id: COLLECTION, status: 'ARCHIVED' };
    await refreshArchive(COLLECTION, 'DELIVERED');
    currentCollection = null;
    await refreshArchive(COLLECTION, 'SELECTION_HD');
    assert.equal(rows.length, 0);
});

test('refreshArchive never throws: a failing trigger must not fail the event that caused it', async () => {
    const db = (await import('../src/repository/db.repository.js')).default;
    const original = db.sequelize.transaction;
    db.sequelize.transaction = async () => { throw new Error('db down'); };
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.doesNotReject(() => refreshArchive(COLLECTION, 'SELECTION_HD'));
    } finally {
        db.sequelize.transaction = original;
        console.error = originalError;
    }
});

test('refreshSelectionArchivesForPhotos refreshes each collection once for photos that got attachments', async () => {
    photoCollections = { 1: COLLECTION, 2: COLLECTION };
    await refreshSelectionArchivesForPhotos([1, 2]);
    assert.equal(rows.length, 1);
});

test('refreshSelectionArchivesForPhotos does nothing for an empty list', async () => {
    await refreshSelectionArchivesForPhotos([]);
    assert.equal(rows.length, 0);
});

test('a new attachment makes the stored retouching ZIP stale', async () => {
    await markDone();
    attachments = [attachment(1, 'IMG_1.CR2')];
    photoCollections = { 1: COLLECTION };
    await refreshSelectionArchivesForPhotos([1]);
    assert.equal(rows[0].status, 'QUEUED');
});

test('discardArchives removes the given kinds, or both by default, and never throws', async () => {
    await ensureArchive(COLLECTION, 'SELECTION_HD');
    await ensureArchive(COLLECTION, 'DELIVERED');
    await discardArchives(COLLECTION, ['SELECTION_HD']);
    assert.deepEqual(rows.map(({ kind }) => kind), ['DELIVERED']);
    await discardArchives(COLLECTION);
    assert.equal(rows.length, 0);

    const s3 = (await import('../src/repository/s3.repository.js')).default;
    const original = s3.deleteByPrefix;
    s3.deleteByPrefix = async () => { throw new Error('S3 down'); };
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.doesNotReject(() => discardArchives(COLLECTION));
    } finally {
        s3.deleteByPrefix = original;
        console.error = originalError;
    }
});

// --- download requests ----------------------------------------------------------------------------

test('the retouching ZIP is requested under <slug>-HD-<date>.zip', async () => {
    await markDone('SELECTION_HD');
    const result = await requestSelectionHdDownload(COLLECTION);
    assert.equal(result.state, 'READY');
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    assert.equal(signedDownloads[0].filename, `mariage-lea-hugo-HD-${date}.zip`);
});

test('the retouching ZIP is refused with 404 for an unknown collection and 409 outside EDITING', async () => {
    currentCollection = null;
    await assert.rejects(() => requestSelectionHdDownload(COLLECTION), (error) => error.status === 404);
    currentCollection = { id: COLLECTION, name: 'x', status: 'READY' };
    await assert.rejects(() => requestSelectionHdDownload(COLLECTION), (error) => error.status === 409);
    assert.equal(rows.length, 0, 'nothing is queued either');
});

test('the delivered ZIP is requested under <slug>-<date>.zip', async () => {
    await markDone('DELIVERED');
    const collection = { id: COLLECTION, name: 'Mariage Léa & Hugo', status: 'READY' };
    const result = await requestDeliveredDownload(collection);
    assert.equal(result.state, 'READY');
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    assert.equal(signedDownloads[0].filename, `mariage-lea-hugo-${date}.zip`);
});

test('the delivered ZIP is a 404 for a collection that is not READY, and queues nothing', async () => {
    for (const status of ['DRAFT', 'SELECTING', 'EDITING', 'ARCHIVED']) {
        await assert.rejects(() => requestDeliveredDownload({ id: COLLECTION, name: 'x', status }), (error) => error.status === 404);
    }
    assert.equal(rows.length, 0);
});

test('toDownloadResponse: 200 with the URL, 202 while preparing, 409 when failed', () => {
    assert.deepEqual(toDownloadResponse('DELIVERED', { state: 'READY', url: 'https://s3/zip' }), { httpStatus: 200, body: { url: 'https://s3/zip' } });
    assert.deepEqual(toDownloadResponse('DELIVERED', { state: 'PENDING', status: 'PROCESSING' }), { httpStatus: 202, body: { status: 'PROCESSING' } });
    assert.deepEqual(toDownloadResponse('SELECTION_HD', { state: 'FAILED' }), { httpStatus: 409, body: { status: 'FAILED' } });
});

test('toDownloadResponse: nothing to zip is a 400 for the selection and a 404 for the delivered photos', () => {
    assert.equal(toDownloadResponse('SELECTION_HD', { state: 'EMPTY' }).httpStatus, 400);
    assert.equal(toDownloadResponse('DELIVERED', { state: 'EMPTY' }).httpStatus, 404);
});

// --- gallery and admin status ------------------------------------------------------------------------

test('getClientArchiveInfo exposes status, size and photo count, nothing else', async () => {
    currentCollection = { id: COLLECTION, status: 'READY' };
    await markDone('DELIVERED');
    assert.deepEqual(await getClientArchiveInfo(COLLECTION), { status: 'DONE', sizeBytes: 1500, photoCount: 2 });
});

test('getClientArchiveInfo queues the ZIP of a READY collection that has none yet (delivered before this feature)', async () => {
    currentCollection = { id: COLLECTION, status: 'READY' };
    const info = await getClientArchiveInfo(COLLECTION);
    assert.equal(info.status, 'QUEUED');
    assert.equal(rows.length, 1);
});

test('getClientArchiveInfo is null when there is nothing to archive', async () => {
    currentCollection = { id: COLLECTION, status: 'READY' };
    deliveredPhotos = [];
    assert.equal(await getClientArchiveInfo(COLLECTION), null);
});

test('getCollectionArchives is null for an unknown collection, the status of both ZIPs otherwise', async () => {
    currentCollection = null;
    assert.equal(await getCollectionArchives(COLLECTION), null);
    currentCollection = { id: COLLECTION };
    await ensureArchive(COLLECTION, 'SELECTION_HD');
    const statuses = await getCollectionArchives(COLLECTION);
    assert.equal(statuses.SELECTION_HD.status, 'QUEUED');
    assert.equal(statuses.DELIVERED, null);
});
