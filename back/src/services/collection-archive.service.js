import crypto from "crypto";
import { UniqueConstraintError } from "sequelize";
import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { ARCHIVE_KINDS } from "../model/collection-archive.model.js";
import { archiveDownloadFilename } from "./filename.util.js";
import { getSelectedPhotosForCollection, getDeliveredPhotosForZip, getAttachmentsForPhotos, getPhotoDownloadFilename } from "./photo.service.js";
import logger from "../logger.js";

const log = logger.child("collection-archive");

export const isArchiveKind = (kind) => ARCHIVE_KINDS.includes(kind);

const archivePrefix = (collectionId) => `archives/${collectionId}/`;

// The fingerprint is part of the key: a new ZIP is written under a new key, so the
// previous one stays downloadable until the new one is DONE.
export const buildArchiveS3Key = (collectionId, kind, fingerprint) =>
    `${archivePrefix(collectionId)}${kind}-${fingerprint.slice(0, 16)}.zip`;

// --- what a ZIP must contain ---------------------------------------------------------

// RAW/XMP attachments, when a SELECTED photo has some, replace its JPEG entirely (Emma
// retouches from the originals, not from the JPEG). Same rule as the former on-demand ZIP.
const listSelectionHdEntries = async (collectionId) => {
    const photos = await getSelectedPhotosForCollection(collectionId);
    const attachments = await getAttachmentsForPhotos(photos.map((photo) => photo.id));
    const attachmentsByPhotoId = new Map();
    for (const attachment of attachments) {
        if (!attachmentsByPhotoId.has(attachment.photoId)) {
            attachmentsByPhotoId.set(attachment.photoId, []);
        }
        attachmentsByPhotoId.get(attachment.photoId).push(attachment);
    }

    return photos.flatMap((photo) => {
        const photoAttachments = attachmentsByPhotoId.get(photo.id) ?? [];
        if (photoAttachments.length > 0) {
            return photoAttachments.map((attachment) => ({ photoId: photo.id, key: attachment.s3Key, name: attachment.originalFilename }));
        }
        return [{ photoId: photo.id, key: photo.key, name: getPhotoDownloadFilename(photo) }];
    });
};

const listDeliveredEntries = async (collectionId) => {
    const photos = await getDeliveredPhotosForZip(collectionId);
    return photos.map((photo) => ({ photoId: photo.id, key: photo.key, name: getPhotoDownloadFilename(photo) }));
};

const ENTRY_LISTERS = {
    SELECTION_HD: listSelectionHdEntries,
    DELIVERED: listDeliveredEntries,
};

// SHA-256 of the sorted `photoId|key` lines. The name of an entry is not part of it: it is
// derived from the photo (`originalFilename`), which never changes once the photo exists.
export const computeFingerprint = (entries) => {
    const lines = entries.map(({ photoId, key }) => `${photoId}|${key}`).sort();
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
};

// What the ZIP of this kind must contain right now: the entries (with the name each one
// gets inside the ZIP, in the order they are written) and their fingerprint.
export const buildArchivePlan = async (collectionId, kind) => {
    const entries = await ENTRY_LISTERS[kind](collectionId);
    return { entries, fingerprint: computeFingerprint(entries) };
};

// --- ensureArchive -----------------------------------------------------------------------

const REQUEUE_FIELDS = { status: 'QUEUED', attempts: 0, error: null, startedAt: null, heartbeatAt: null };

// Looks at the row under a lock, so it serializes with the worker's own guarded updates.
const reconcileArchiveRow = (collectionId, kind, fingerprint) => db.sequelize.transaction(async (transaction) => {
    const archive = await db.CollectionArchive.findOne({
        where: { collectionId, kind },
        transaction,
        lock: transaction.LOCK.UPDATE
    });

    if (!archive) {
        const created = await db.CollectionArchive.create({ collectionId, kind, fingerprint, status: 'QUEUED' }, { transaction });
        return { archive: created, queued: true };
    }

    // Up to date: nothing to build.
    if (archive.status === 'DONE' && archive.builtFingerprint === fingerprint) {
        if (archive.fingerprint !== fingerprint) {
            await archive.update({ fingerprint }, { transaction });
        }
        return { archive, queued: false };
    }

    // Already waiting or being built: only the target moves. A build in progress notices it
    // at the end (the worker compares what it built with `fingerprint`) and runs again.
    if (archive.status === 'QUEUED' || archive.status === 'PROCESSING') {
        if (archive.fingerprint !== fingerprint) {
            await archive.update({ fingerprint }, { transaction });
        }
        return { archive, queued: false };
    }

    // FAILED for this very content: it stays FAILED until a manual retry, otherwise every
    // download request would restart a build that keeps failing.
    if (archive.status === 'FAILED' && archive.fingerprint === fingerprint) {
        return { archive, queued: false };
    }

    // DONE but stale, or FAILED for content that has changed since: build again. `s3Key` is
    // kept on purpose: the previous ZIP stays downloadable until the new one replaces it.
    await archive.update({ ...REQUEUE_FIELDS, fingerprint }, { transaction });
    return { archive, queued: true };
});

// Makes sure a ZIP of this kind is, or will be, up to date. Idempotent: it only queues
// when what the stored ZIP contains differs from what it should contain, so it can be
// called after any event that may have changed the content. Resolves to
// { archive, queued }; `archive` is null when there is nothing to put in a ZIP (any
// stored ZIP is then removed). It does not check the collection's status: that is the
// caller's business.
export const ensureArchive = async (collectionId, kind) => {
    if (!isArchiveKind(kind)) {
        throw new Error(`Unknown archive kind: ${kind}`);
    }
    try {
        const { entries, fingerprint } = await buildArchivePlan(collectionId, kind);
        if (entries.length === 0) {
            log.debug("No file to archive, removing any stored ZIP", { collectionId, kind });
            await deleteArchive(collectionId, kind);
            return { archive: null, queued: false };
        }

        let result;
        try {
            result = await reconcileArchiveRow(collectionId, kind, fingerprint);
        } catch (error) {
            if (!(error instanceof UniqueConstraintError)) throw error;
            // Two callers created the row at the same time: the second one now finds it.
            result = await reconcileArchiveRow(collectionId, kind, fingerprint);
        }
        if (result.queued) {
            log.info("Archive queued", { collectionId, kind, fingerprint: fingerprint.slice(0, 12), fileCount: entries.length });
        }
        return result;
    } catch (error) {
        log.failure("Could not ensure the archive", error, { collectionId, kind });
        throw error;
    }
};

// --- reading -------------------------------------------------------------------------------

export const toArchiveDTO = (archive) => {
    if (!archive) return null;
    return {
        kind: archive.kind,
        status: archive.status,
        sizeBytes: archive.sizeBytes === null || archive.sizeBytes === undefined ? null : Number(archive.sizeBytes),
        photoCount: archive.photoCount ?? null,
        error: archive.status === 'FAILED' ? archive.error ?? null : null
    };
};

// Cheap read for the polling (no fingerprint computed): what is stored, as is.
export const getArchiveStatus = async (collectionId, kind) => {
    const archive = await db.CollectionArchive.findOne({ where: { collectionId, kind } });
    return toArchiveDTO(archive);
};

export const getArchivesStatus = async (collectionId) => {
    const archives = await db.CollectionArchive.findAll({ where: { collectionId } });
    return Object.fromEntries(ARCHIVE_KINDS.map((kind) => [kind, toArchiveDTO(archives.find((archive) => archive.kind === kind))]));
};

// The decision behind the download routes. Re-checks the content first (ensureArchive), so
// a ZIP that was lost or became stale is rebuilt by the first request that notices it.
//   READY   -> { state, url }       the ZIP is there and up to date
//   PENDING -> { state, status }    queued or being built (the client polls)
//   FAILED  -> { state }            gave up, needs a retry
//   EMPTY   -> { state }            nothing to put in a ZIP
export const resolveArchiveDownload = async (collectionId, kind, downloadFilename) => {
    const { archive } = await ensureArchive(collectionId, kind);
    if (!archive) {
        return { state: 'EMPTY' };
    }
    if (archive.status === 'FAILED') {
        return { state: 'FAILED' };
    }
    if (archive.status === 'DONE' && archive.builtFingerprint === archive.fingerprint && archive.s3Key) {
        // The row says the ZIP is there; the bucket has the last word (manual deletion, incident).
        // A lost file is rebuilt by the request that notices it, instead of handing out a link
        // that leads nowhere.
        if (!await s3Repository.objectExists(archive.s3Key)) {
            log.warn("Archive file missing in storage, rebuilding it", { collectionId, kind, s3Key: archive.s3Key });
            await db.CollectionArchive.update(
                { ...REQUEUE_FIELDS, builtFingerprint: null, s3Key: null, sizeBytes: null, photoCount: null },
                { where: { id: archive.id, status: 'DONE' } }
            );
            return { state: 'PENDING', status: 'QUEUED' };
        }
        const url = await s3Repository.getSignedArchiveDownloadUrl(archive.s3Key, downloadFilename);
        return { state: 'READY', url };
    }
    return { state: 'PENDING', status: archive.status };
};

// --- retry and cleanup -----------------------------------------------------------------

// FAILED -> QUEUED with a fresh attempt counter. Resolves to the archive, or null when
// there is no FAILED archive of this kind (nothing to retry).
export const retryArchive = async (collectionId, kind) => {
    const archive = await db.CollectionArchive.findOne({ where: { collectionId, kind } });
    if (!archive || archive.status !== 'FAILED') {
        log.debug("Archive retry ignored: nothing in FAILED status", { collectionId, kind, status: archive?.status ?? null });
        return null;
    }
    const [updatedRows] = await db.CollectionArchive.update(REQUEUE_FIELDS, { where: { id: archive.id, status: 'FAILED' } });
    if (updatedRows === 0) {
        return null;
    }
    log.info("Archive retry requested", { collectionId, kind });
    // The content may have changed since the failure.
    const { archive: refreshed } = await ensureArchive(collectionId, kind);
    return refreshed;
};

// Removes the ZIP of one kind: S3 first (a failure leaves the row, so the cleanup can be
// retried), then the row. The prefix also catches a ZIP uploaded by a build whose result
// was never recorded.
export const deleteArchive = async (collectionId, kind) => {
    const deleted = await s3Repository.deleteByPrefix(`${archivePrefix(collectionId)}${kind}-`);
    const destroyed = await db.CollectionArchive.destroy({ where: { collectionId, kind } });
    if (deleted > 0 || destroyed > 0) {
        log.info("Archive deleted", { collectionId, kind, deletedObjects: deleted });
    }
};

// Every ZIP of the collection (ARCHIVED, or deletion of the collection).
export const deleteArchivesForCollection = async (collectionId) => {
    const deleted = await s3Repository.deleteByPrefix(archivePrefix(collectionId));
    const destroyed = await db.CollectionArchive.destroy({ where: { collectionId } });
    if (deleted > 0 || destroyed > 0) {
        log.info("Archives of the collection deleted", { collectionId, deletedObjects: deleted, deletedRows: destroyed });
    }
};

// --- triggers and routes (the glue used by the collection, photo and client code) ------------

// The status a collection must be in for a ZIP of each kind to make sense: the selection is
// zipped for the retoucher while EDITING, the delivered photos for the client once READY.
const ARCHIVE_COLLECTION_STATUS = { SELECTION_HD: 'EDITING', DELIVERED: 'READY' };

// Called after any event that may have changed the content of a ZIP. Best effort: the event
// itself (status change, upload...) has already happened and must not fail because of a ZIP;
// a missed trigger is repaired by the next download request or by the worker's end check.
// Does nothing when the collection is not in the status where this ZIP is wanted.
export const refreshArchive = async (collectionId, kind) => {
    try {
        const collection = await db.Collection.findByPk(collectionId, { attributes: ['id', 'status'] });
        if (collection?.status !== ARCHIVE_COLLECTION_STATUS[kind]) {
            log.debug("Archive refresh skipped: collection not in the matching status", { collectionId, kind, status: collection?.status ?? null });
            return;
        }
        await ensureArchive(collectionId, kind);
    } catch (error) {
        log.failure("Could not refresh the archive after an event (it will be repaired on the next request)", error, { collectionId, kind });
    }
};

// RAW/XMP attachments were added to these photos: the retouching ZIP of their collections
// has to be rebuilt.
export const refreshSelectionArchivesForPhotos = async (photoIds) => {
    if (photoIds.length === 0) return;
    try {
        const photos = await db.Photo.findAll({ where: { id: photoIds }, attributes: ['collectionId'] });
        const collectionIds = [...new Set(photos.map(({ collectionId }) => collectionId))];
        for (const collectionId of collectionIds) {
            await refreshArchive(collectionId, 'SELECTION_HD');
        }
    } catch (error) {
        log.failure("Could not refresh the archives after an attachment upload", error, { photoIds });
    }
};

// Best effort too (see markCollectionAsReady: a slow or failing bucket must not block the
// transition). A ZIP left behind is removed with the collection.
export const discardArchives = async (collectionId, kinds = ARCHIVE_KINDS) => {
    for (const kind of kinds) {
        try {
            await deleteArchive(collectionId, kind);
        } catch (error) {
            log.failure("Could not delete an archive (orphaned file)", error, { collectionId, kind });
        }
    }
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

// The retouching ZIP is for Emma, while the collection is being retouched.
export const requestSelectionHdDownload = async (collectionId) => {
    const collection = await db.Collection.findByPk(collectionId);
    if (!collection) {
        throw httpError(404, 'Collection introuvable');
    }
    if (collection.status !== ARCHIVE_COLLECTION_STATUS.SELECTION_HD) {
        throw httpError(409, 'La collection doit être en phase Retouche pour télécharger la sélection HD.');
    }
    return resolveArchiveDownload(collectionId, 'SELECTION_HD', archiveDownloadFilename(collection.name, 'SELECTION_HD'));
};

// `collection` comes from the access token (loadGalleryByToken). Outside READY there is
// nothing to download: same answer as an unknown token.
export const requestDeliveredDownload = async (collection) => {
    if (collection.status !== ARCHIVE_COLLECTION_STATUS.DELIVERED) {
        throw httpError(404, 'Not found');
    }
    return resolveArchiveDownload(collection.id, 'DELIVERED', archiveDownloadFilename(collection.name, 'DELIVERED'));
};

// The contract of the download routes (the same for the admin and the client):
//   200 { url }       the ZIP is ready, download it from S3
//   202 { status }    being prepared, ask again in a few seconds
//   409 { status }    the build failed for good
//   404 / 400         nothing to put in a ZIP
export const toDownloadResponse = (kind, result) => {
    switch (result.state) {
        case 'READY': return { httpStatus: 200, body: { url: result.url } };
        case 'PENDING': return { httpStatus: 202, body: { status: result.status } };
        case 'FAILED': return { httpStatus: 409, body: { status: 'FAILED' } };
        default:
            return kind === 'SELECTION_HD'
                ? { httpStatus: 400, body: { error: 'Aucune photo sélectionnée dans cette collection.' } }
                : { httpStatus: 404, body: { error: 'Aucune photo livrée dans cette collection.' } };
    }
};

// What the client gallery shows on the "download all" button. A READY collection without
// any archive (delivered before ZIPs were pre-generated, or whose ZIP was lost) gets it
// queued here, so the button is right on the first visit.
export const getClientArchiveInfo = async (collectionId) => {
    let archive = await getArchiveStatus(collectionId, 'DELIVERED');
    if (!archive) {
        await refreshArchive(collectionId, 'DELIVERED');
        archive = await getArchiveStatus(collectionId, 'DELIVERED');
    }
    return archive ? { status: archive.status, sizeBytes: archive.sizeBytes, photoCount: archive.photoCount } : null;
};

// Status of both ZIPs for the admin (polling). Null when the collection does not exist.
export const getCollectionArchives = async (collectionId) => {
    const collection = await db.Collection.findByPk(collectionId, { attributes: ['id'] });
    return collection ? getArchivesStatus(collectionId) : null;
};
