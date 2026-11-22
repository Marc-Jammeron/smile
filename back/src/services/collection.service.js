import crypto from "crypto";
import { Op } from "sequelize";
import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { getAttachmentsForPhotos } from "./photo.service.js";
import { refreshArchive, discardArchives, deleteArchivesForCollection } from "./collection-archive.service.js";
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

// Counters for the admin polling. Archived photos (soft-deleted) are ignored.
// Resolves to null when the collection does not exist.
export const getCollectionProcessingStatus = async (id) => {
    try {
        const collection = await db.Collection.findByPk(id, { attributes: ['id', 'status', 'sendRequestedAt'] });
        if (!collection) {
            return null;
        }
        const rows = await db.Photo.findAll({
            where: { collectionId: id, status: { [Op.ne]: 'ARCHIVED' } },
            attributes: ['processingStatus', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
            group: ['processingStatus'],
            raw: true
        });
        const counts = { queued: 0, processing: 0, done: 0, failed: 0 };
        for (const { processingStatus, count } of rows) {
            counts[processingStatus.toLowerCase()] = Number(count);
        }
        return { ...counts, status: collection.status, sendRequestedAt: collection.sendRequestedAt };
    } catch (error) {
        log.failure("Error fetching collection processing status", error, { collectionId: id });
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

// The ZIPs follow the status. Entering EDITING (the client validated, or the photographer
// moved the collection) queues the retouching ZIP. ARCHIVED removes every ZIP: nobody can
// reach them any more. It also runs when the collection is already ARCHIVED, so repeating
// the request cleans up what a previous failure left behind. Neither can fail the change.
const updateArchivesAfterStatusChange = async (collectionId, previousStatus, newStatus) => {
    if (newStatus === 'EDITING' && previousStatus !== 'EDITING') {
        await refreshArchive(collectionId, 'SELECTION_HD');
    } else if (newStatus === 'ARCHIVED') {
        await discardArchives(collectionId);
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

        let previousStatus = null;
        if (collectionData.status !== undefined) {
            const collection = await db.Collection.findByPk(id);
            if (!collection) {
                log.debug("Collection to update not found", { collectionId: id });
                return null;
            }
            previousStatus = collection.status;
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
        await updateArchivesAfterStatusChange(id, previousStatus, collectionData.status);
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
        // Pre-generated ZIPs (their rows go with the collection, their files do not).
        await deleteArchivesForCollection(id);

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

    const unprocessedDeliveredCount = await db.Photo.count({ where: { collectionId: id, status: 'DELIVERED', processingStatus: { [Op.ne]: 'DONE' } } });
    if (unprocessedDeliveredCount > 0) {
        log.warn("Mark as ready refused: delivered photos are not all processed", { collectionId: id, unprocessedDeliveredCount });
        const error = new Error('Toutes les photos livrées doivent être traitées avant de marquer la collection comme prête.');
        error.status = 409;
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

    // Only now that the non-delivered photos are gone: the retouching ZIP contains originals
    // that no longer exist, the delivered ZIP is built from what is left.
    await discardArchives(id, ['SELECTION_HD']);
    await refreshArchive(id, 'DELIVERED');

    return await db.Collection.findByPk(id);
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