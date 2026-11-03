import crypto from "crypto";
import archiver from "archiver";
import { Op } from "sequelize";
import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { getSelectedPhotosForCollection, getDeliveredPhotosForZip, getPhotoDownloadFilename, getAttachmentsForPhotos } from "./photo.service.js";
import logger from "../logger.js";

const log = logger.child("collection.service");

export const getAllCollections = async () => {
    try {
        const collections = await db.Collection.findAll({
            include: db.Photo,
            order: [[db.Photo, 'position', 'ASC'], [db.Photo, 'id', 'ASC']]
        });
        return collections;
    } catch (error) {
        log.failure("Error fetching collections", error);
        throw error;
    }
};

export const getCollectionById = async (id) => {
    try {
        const collection = await db.Collection.findByPk(id, {
            include: db.Photo,
            order: [[db.Photo, 'position', 'ASC'], [db.Photo, 'id', 'ASC']]
        });
        return collection;
    } catch (error) {
        log.failure("Error fetching collection", error, { collectionId: id });
        throw error;
    }
};

// A new collection can only start as a DRAFT or straight in EDITING (final photos
// uploaded directly, no client selection). SELECTING needs the access token and the
// photos to be set up, READY needs delivered photos and ARCHIVED is an end state: all
// of them are reached through updateCollection / markCollectionAsReady.
export const CREATABLE_STATUSES = ['DRAFT', 'EDITING'];

// Statuses a collection can be moved to from each status (the card's dropdown, i.e. the
// PUT route). READY is absent from every list on purpose: it is only reachable through
// markCollectionAsReady, which checks the delivered photos and cleans up the rest.
// ARCHIVED is final. Must match ALLOWED_STATUS_TRANSITIONS in front-shared.
export const ALLOWED_STATUS_TRANSITIONS = {
    DRAFT: ['SELECTING', 'EDITING', 'ARCHIVED'],
    SELECTING: ['DRAFT', 'EDITING', 'ARCHIVED'],
    EDITING: ['SELECTING', 'ARCHIVED'],
    READY: ['ARCHIVED'],
    ARCHIVED: []
};

// Only these fields can be written from a request body. Everything else (accessToken,
// accessTokenExpiresAt, accessTokenRevokedAt, viewedByCustomer, id, timestamps...) is
// managed by the server and must never come from the client.
export const CREATABLE_COLLECTION_FIELDS = ['name', 'clientName', 'status', 'maxPhotos', 'clientMessage', 'finalMessage'];
export const UPDATABLE_COLLECTION_FIELDS = ['name', 'clientName', 'status', 'maxPhotos', 'clientMessage', 'finalMessage'];

export const pickCollectionFields = (data, allowedFields) =>
    Object.fromEntries(Object.entries(data ?? {}).filter(([field]) => allowedFields.includes(field)));

export const createCollection = async (rawCollectionData) => {
    try {
        const collectionData = pickCollectionFields(rawCollectionData, CREATABLE_COLLECTION_FIELDS);
        log.debug("Creating collection", { fields: Object.keys(collectionData) });
        if (collectionData?.status !== undefined && !CREATABLE_STATUSES.includes(collectionData.status)) {
            log.warn("Collection creation refused: status not allowed at creation", { status: collectionData.status });
            const error = new Error(`A collection can only be created in ${CREATABLE_STATUSES.join(' or ')} status`);
            error.status = 400;
            throw error;
        }
        const newCollection = await db.Collection.create(collectionData);
        return newCollection;
    } catch (error) {
        log.failure("Error creating collection", error);
        throw error;
    }
};

export const CLIENT_MESSAGE_MAX_LENGTH = 3000;
const CLIENT_MESSAGE_FIELDS = ['clientMessage', 'finalMessage'];

const assertStatusTransitionAllowed = (collection, newStatus) => {
    if (collection.status === newStatus) return;
    if (!ALLOWED_STATUS_TRANSITIONS[collection.status]?.includes(newStatus)) {
        log.warn("Status change refused: transition not allowed", { collectionId: collection.id, from: collection.status, to: newStatus });
        const error = newStatus === 'READY'
            ? new Error('Use "mark as ready" to deliver a collection.')
            : new Error(`A collection cannot go from ${collection.status} to ${newStatus}`);
        error.status = 400;
        throw error;
    }
};

export const updateCollection = async (id, collectionData) => {
    try {
        // clientMessage is shown while the client selects, finalMessage once the collection is READY.
        for (const field of CLIENT_MESSAGE_FIELDS) {
            if (!(field in collectionData)) continue;
            const message = typeof collectionData[field] === 'string'
                ? collectionData[field].trim() || null
                : null;
            if (message && message.length > CLIENT_MESSAGE_MAX_LENGTH) {
                log.debug("Client message too long", { collectionId: id, field, length: message.length, max: CLIENT_MESSAGE_MAX_LENGTH });
                const error = new Error(`Le message client ne peut pas dépasser ${CLIENT_MESSAGE_MAX_LENGTH} caractères.`);
                error.status = 400;
                throw error;
            }
            collectionData = { ...collectionData, [field]: message };
        }

        if (collectionData.status !== undefined) {
            const collection = await db.Collection.findByPk(id);
            if (!collection) {
                log.debug("Collection to update not found", { collectionId: id });
                return null;
            }
            assertStatusTransitionAllowed(collection, collectionData.status);
            if (collectionData.status === 'SELECTING' && !collection.accessToken) {
                collectionData = { ...collectionData, accessToken: crypto.randomBytes(32).toString('base64url') };
                log.info("Access token generated for collection entering SELECTING", { collectionId: id });
            }
        }

        const [updatedRows] = await db.Collection.update(collectionData, {
            where: { id }
        });
        if (updatedRows === 0) {
            log.debug("No collection row updated", { collectionId: id });
            return null;
        }
        if (collectionData.status) {
            log.info("Collection status changed", { collectionId: id, status: collectionData.status });
        }
        return await db.Collection.findByPk(id);
    } catch (error) {
        log.failure("Error updating collection", error, { collectionId: id });
        throw error;
    }
};

// Permanently removes a collection and everything attached to it: S3 objects
// (originals, thumbnails, previews, RAW/XMP attachments, and any orphaned upload
// under the collection's prefixes), DB rows (Photos and PhotoAttachments go through
// the FKs' ON DELETE CASCADE) and, since the access token lives on the collection
// row, the client link. S3 goes first and any failure aborts before the DB is
// touched: the collection stays visible and the delete can simply be retried, rather
// than leaving unreachable files in the bucket with no row left to point at them.
export const deleteCollection = async (id) => {
    try {
        const collection = await db.Collection.findByPk(id);
        if (!collection) {
            log.debug("Collection to delete not found", { collectionId: id });
            return false;
        }

        log.info("Deleting collection and all its files", { collectionId: id, name: collection.name });
        const photos = await db.Photo.findAll({ where: { collectionId: id } });
        const attachments = await getAttachmentsForPhotos(photos.map((photo) => photo.id));
        const keys = [
            ...photos.flatMap((photo) => [photo.key, photo.thumbnailKey, photo.previewKey]),
            ...attachments.map((attachment) => attachment.s3Key)
        ].filter(Boolean);

        log.debug("Deleting collection files from storage", { collectionId: id, photoCount: photos.length, attachmentCount: attachments.length, objectCount: keys.length });
        for (const key of keys) {
            await s3Repository.deleteObject(key);
        }
        // Catches whatever the DB doesn't know about (unconfirmed uploads, leftovers).
        await s3Repository.deleteByPrefix(`uploads/${id}/`);
        await s3Repository.deleteByPrefix(`attachments/${id}/`);

        await db.Collection.destroy({ where: { id } });
        log.info("Collection deleted", { collectionId: id, deletedObjects: keys.length });
        return true;
    } catch (error) {
        log.failure("Error deleting collection (storage may be partially cleaned, retry is safe)", error, { collectionId: id });
        throw error;
    }
};

export const revokeCollectionAccess = async (id) => {
    try {
        const [updatedRows] = await db.Collection.update({ accessTokenRevokedAt: new Date() }, {
            where: { id }
        });
        log.debug("Revoke access done", { collectionId: id, updatedRows });
        return updatedRows > 0;
    } catch (error) {
        log.failure("Error revoking collection access", error, { collectionId: id });
        throw error;
    }
};

const stripDiacritics = (value) => Array.from(value.normalize('NFD'))
    .filter((char) => {
        const codePoint = char.codePointAt(0);
        return codePoint < 0x0300 || codePoint > 0x036f; // combining diacritical marks block
    })
    .join('');

const slugifyCollectionName = (name) => {
    const slug = stripDiacritics(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-+|-+$)/g, '');
    return slug || 'collection';
};

// Streams the ZIP directly to `res` (archiver piped into the response, no temp file
// and no full in-memory buffer). Errors are split by whether any bytes have already
// reached the client: before that point we can still throw and let the caller answer
// with a JSON error; once streaming has started, the HTTP status is already sent, so
// we can only log server-side and drop the connection.
export const streamSelectionHdZip = async (collectionId, res) => {
    const collection = await db.Collection.findByPk(collectionId);
    if (!collection) {
        const error = new Error('Collection introuvable');
        error.status = 404;
        throw error;
    }
    if (collection.status !== 'EDITING') {
        log.debug("HD ZIP refused: wrong collection status", { collectionId, status: collection.status });
        const error = new Error('La collection doit être en phase Retouche pour télécharger la sélection HD.');
        error.status = 409;
        throw error;
    }

    const photos = await getSelectedPhotosForCollection(collectionId);
    if (photos.length === 0) {
        const error = new Error('Aucune photo sélectionnée dans cette collection.');
        error.status = 400;
        throw error;
    }

    // RAW/XMP attachments, when present, replace the JPEG entirely for that photo
    // (not added alongside it) — Emma retouches from the originals, not the JPEG,
    // once she has them. No attachments -> fallback to the JPEG HD file as before.
    const attachments = await getAttachmentsForPhotos(photos.map((photo) => photo.id));
    const attachmentsByPhotoId = new Map();
    for (const attachment of attachments) {
        if (!attachmentsByPhotoId.has(attachment.photoId)) {
            attachmentsByPhotoId.set(attachment.photoId, []);
        }
        attachmentsByPhotoId.get(attachment.photoId).push(attachment);
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const zipFilename = `${slugifyCollectionName(collection.name)}-HD-${date}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    let archiveError = null;
    archive.on('error', (err) => {
        archiveError = err;
        log.error("Archiver error while building the selection HD ZIP", err, { collectionId });
        archive.abort();
    });
    archive.on('warning', (err) => {
        log.warn("Archiver warning while building the selection HD ZIP", err, { collectionId });
    });
    archive.pipe(res);
    log.debug("Streaming selection HD ZIP", { collectionId, zipFilename, photoCount: photos.length, attachmentCount: attachments.length });

    // Failures are collected instead of just logged: a missing CR2 makes a photo
    // unretouchable, so it must be visible in the delivered ZIP, not just in server
    // logs. A per-file failure never aborts the rest of the stream.
    const failures = [];

    const appendToZip = async (s3Key, entryName, describeFailure) => {
        try {
            const stream = await s3Repository.getObjectStream(s3Key);
            stream.on('error', (err) => {
                log.error(`Error streaming ${describeFailure}`, err, { collectionId, s3Key });
            });
            archive.append(stream, { name: entryName });
            log.debug("Added file to selection HD ZIP", { collectionId, entryName });
        } catch (err) {
            log.error(`Error fetching ${describeFailure} from storage`, err, { collectionId, s3Key });
            failures.push(`${entryName}: ${err.message}`);
        }
    };

    for (const photo of photos) {
        const photoAttachments = attachmentsByPhotoId.get(photo.id) || [];
        if (photoAttachments.length > 0) {
            for (const attachment of photoAttachments) {
                await appendToZip(attachment.s3Key, attachment.originalFilename, `attachment for photo ${photo.id}`);
            }
        } else {
            await appendToZip(photo.key, getPhotoDownloadFilename(photo), `original HD file for photo ${photo.id}`);
        }
    }

    if (failures.length > 0) {
        log.warn("Selection HD ZIP is missing files, adding _erreurs.txt", { collectionId, failureCount: failures.length });
        archive.append(Buffer.from(failures.join('\n'), 'utf-8'), { name: '_erreurs.txt' });
    }

    await archive.finalize();
    log.debug("Selection HD ZIP finalized", { collectionId, bytes: archive.pointer(), failureCount: failures.length });

    if (archiveError) {
        if (res.headersSent) {
            log.error("Selection HD ZIP broken (streaming already started)", archiveError, { collectionId });
            return;
        }
        const error = new Error('Erreur lors de la génération du ZIP');
        error.status = 500;
        throw error;
    }
};

// Finalizes delivery: everything that isn't DELIVERED (PENDING/SELECTED/REJECTED
// originals) is permanently discarded so the client gallery only ever shows the
// retouched photos. DB rows are deleted inside a transaction alongside the status
// flip so the two can't disagree if the process crashes mid-way; the S3 objects are
// cleaned up afterwards since storage has no transactional guarantee with the DB and
// the READY transition should not be blocked by a slow/failing bucket.
export const markCollectionAsReady = async (id) => {
    log.debug("Marking collection as ready", { collectionId: id });
    const collection = await db.Collection.findByPk(id);
    if (!collection) {
        const error = new Error('Collection introuvable');
        error.status = 404;
        throw error;
    }
    if (collection.status !== 'EDITING') {
        const error = new Error('La collection doit être en phase Retouche pour être marquée comme prête.');
        error.status = 409;
        throw error;
    }

    const deliveredCount = await db.Photo.count({ where: { collectionId: id, status: 'DELIVERED' } });
    if (deliveredCount === 0) {
        const error = new Error('Au moins une photo livrée est requise pour marquer la collection comme prête.');
        error.status = 400;
        throw error;
    }

    log.info("Delivering collection: discarding non-delivered photos", { collectionId: id, deliveredCount });
    let photosToDelete = [];
    let attachmentsToDelete = [];
    await db.sequelize.transaction(async (transaction) => {
        photosToDelete = await db.Photo.findAll({
            where: { collectionId: id, status: { [Op.ne]: 'DELIVERED' } },
            transaction
        });

        // Fetched before the destroy below: the FK's ON DELETE CASCADE (see
        // PhotoAttachments migration) removes these rows from the DB automatically,
        // but their S3 objects still need their keys collected for cleanup.
        attachmentsToDelete = await getAttachmentsForPhotos(photosToDelete.map((photo) => photo.id), { transaction });

        await db.Photo.destroy({
            where: { collectionId: id, status: { [Op.ne]: 'DELIVERED' } },
            transaction
        });

        // A collection created straight in EDITING (no client selection) never went through SELECTING,
        // so it has no client link yet: it must get one now that the client can see it.
        const readyData = { status: 'READY' };
        if (!collection.accessToken) {
            readyData.accessToken = crypto.randomBytes(32).toString('base64url');
            log.info("Access token generated for collection entering READY", { collectionId: id });
        }
        await db.Collection.update(readyData, { where: { id }, transaction });
    });

    log.info("Collection flagged READY in database", { collectionId: id, discardedPhotos: photosToDelete.length, discardedAttachments: attachmentsToDelete.length });

    const keys = [
        ...photosToDelete.flatMap((photo) => [photo.key, photo.thumbnailKey, photo.previewKey].filter(Boolean)),
        ...attachmentsToDelete.map((attachment) => attachment.s3Key)
    ];
    let failedDeletions = 0;
    for (const key of keys) {
        try {
            await s3Repository.deleteObject(key);
        } catch (error) {
            failedDeletions += 1;
            log.error("Could not delete S3 object after marking collection as ready (orphaned file)", error, { collectionId: id, key });
        }
    }
    log.info("Storage cleanup after delivery done", { collectionId: id, objectCount: keys.length, failedDeletions });

    return await db.Collection.findByPk(id);
};

// Same archiver-streaming pattern as streamSelectionHdZip (§ admin HD download), but
// for the client-facing "download all" of the final DELIVERED photos once the
// collection is READY. `collection` is passed in already loaded (by loadGalleryByToken)
// rather than re-fetched by id, since the client route resolves it from the access token.
export const streamDeliveredZip = async (collection, res) => {
    if (collection.status !== 'READY') {
        const error = new Error('La collection doit être prête pour télécharger les photos livrées.');
        error.status = 409;
        throw error;
    }

    const photos = await getDeliveredPhotosForZip(collection.id);
    log.debug("Streaming delivered ZIP", { collectionId: collection.id, photoCount: photos.length });

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const zipFilename = `${slugifyCollectionName(collection.name)}-${date}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    let archiveError = null;
    archive.on('error', (err) => {
        archiveError = err;
        log.error("Archiver error while building the delivered ZIP", err, { collectionId: collection.id });
        archive.abort();
    });
    archive.on('warning', (err) => {
        log.warn("Archiver warning while building the delivered ZIP", err, { collectionId: collection.id });
    });
    archive.pipe(res);

    let skippedFiles = 0;
    for (const photo of photos) {
        try {
            const stream = await s3Repository.getObjectStream(photo.key);
            stream.on('error', (err) => {
                log.error("Error streaming delivered file", err, { photoId: photo.id, collectionId: collection.id });
            });
            archive.append(stream, { name: getPhotoDownloadFilename(photo) });
        } catch (err) {
            skippedFiles += 1;
            log.error("Error fetching delivered file from storage, it will be missing from the ZIP", err, { photoId: photo.id, collectionId: collection.id });
        }
    }

    await archive.finalize();
    log.debug("Delivered ZIP finalized", { collectionId: collection.id, bytes: archive.pointer(), skippedFiles });

    if (archiveError) {
        if (res.headersSent) {
            log.error("Delivered ZIP broken (streaming already started)", archiveError, { collectionId: collection.id });
            return;
        }
        const error = new Error('Erreur lors de la génération du ZIP');
        error.status = 500;
        throw error;
    }
};

export const markCollectionAsViewed = async (id) => {
    try {
        await db.Collection.update({ viewedByCustomer: true }, {
            where: { id, viewedByCustomer: false }
        });
        log.debug("Collection marked as viewed", { collectionId: id });
    } catch (error) {
        log.failure("Error marking collection as viewed", error, { collectionId: id });
        throw error;
    }
};