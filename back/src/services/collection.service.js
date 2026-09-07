import crypto from "crypto";
import archiver from "archiver";
import { Op } from "sequelize";
import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { getSelectedPhotosForCollection, getDeliveredPhotosForZip, getPhotoDownloadFilename, getAttachmentsForPhotos } from "./photo.service.js";

export const getAllCollections = async () => {
    try {
        const collections = await db.Collection.findAll({
            include: db.Photo
        });
        return collections;
    } catch (error) {
        console.error("Error fetching collections:", error);
        throw error;
    }
};

export const getCollectionById = async (id) => {
    try {
        const collection = await db.Collection.findByPk(id, {
            include: db.Photo
        });
        return collection;
    } catch (error) {
        console.error(`Error fetching collection with id ${id}:`, error);
        throw error;
    }
};

export const createCollection = async (collectionData) => {
    try {
        const newCollection = await db.Collection.create(collectionData);
        return newCollection;
    } catch (error) {
        console.error("Error creating collection:", error);
        throw error;
    }
};

export const updateCollection = async (id, collectionData) => {
    try {
        if (collectionData.status === 'SELECTING') {
            const collection = await db.Collection.findByPk(id);
            if (collection && !collection.accessToken) {
                collectionData = { ...collectionData, accessToken: crypto.randomBytes(32).toString('base64url') };
            }
        }

        const [updatedRows] = await db.Collection.update(collectionData, {
            where: { id }
        });
        if (updatedRows === 0) {
            return null;
        }
        return await db.Collection.findByPk(id);
    } catch (error) {
        console.error(`Error updating collection with id ${id}:`, error);
        throw error;
    }
};

export const softDeleteCollection = async (id) => {
    try {
        const [updatedRows] = await db.Collection.update({ status: 'ARCHIVED' }, {
            where: { id }
        });
        return updatedRows > 0;
    } catch (error) {
        console.error(`Error soft deleting collection with id ${id}:`, error);
        throw error;
    }
};

export const revokeCollectionAccess = async (id) => {
    try {
        const [updatedRows] = await db.Collection.update({ accessTokenRevokedAt: new Date() }, {
            where: { id }
        });
        return updatedRows > 0;
    } catch (error) {
        console.error(`Error revoking access for collection with id ${id}:`, error);
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
        archive.abort();
    });
    archive.pipe(res);

    // Failures are collected instead of just logged: a missing CR2 makes a photo
    // unretouchable, so it must be visible in the delivered ZIP, not just in server
    // logs. A per-file failure never aborts the rest of the stream.
    const failures = [];

    const appendToZip = async (s3Key, entryName, describeFailure) => {
        try {
            const stream = await s3Repository.getObjectStream(s3Key);
            stream.on('error', (err) => {
                console.error(`Error streaming ${describeFailure} from collection ${collectionId}:`, err.message);
            });
            archive.append(stream, { name: entryName });
        } catch (err) {
            console.error(`Error fetching ${describeFailure} from collection ${collectionId} from storage:`, err.message);
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
        archive.append(Buffer.from(failures.join('\n'), 'utf-8'), { name: '_erreurs.txt' });
    }

    await archive.finalize();

    if (archiveError) {
        if (res.headersSent) {
            console.error(`Error generating selection HD zip for collection ${collectionId} (streaming already started):`, archiveError.message);
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

        await db.Collection.update({ status: 'READY' }, { where: { id }, transaction });
    });

    const keys = [
        ...photosToDelete.flatMap((photo) => [photo.key, photo.thumbnailKey, photo.previewKey].filter(Boolean)),
        ...attachmentsToDelete.map((attachment) => attachment.s3Key)
    ];
    for (const key of keys) {
        try {
            await s3Repository.deleteObject(key);
        } catch (error) {
            console.error(`Error deleting S3 object with key ${key} after marking collection ${id} as ready:`, error.message);
        }
    }

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

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const zipFilename = `${slugifyCollectionName(collection.name)}-${date}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    let archiveError = null;
    archive.on('error', (err) => {
        archiveError = err;
        archive.abort();
    });
    archive.pipe(res);

    for (const photo of photos) {
        try {
            const stream = await s3Repository.getObjectStream(photo.key);
            stream.on('error', (err) => {
                console.error(`Error streaming delivered file for photo ${photo.id} of collection ${collection.id}:`, err.message);
            });
            archive.append(stream, { name: getPhotoDownloadFilename(photo) });
        } catch (err) {
            console.error(`Error fetching delivered file for photo ${photo.id} of collection ${collection.id} from storage:`, err.message);
        }
    }

    await archive.finalize();

    if (archiveError) {
        if (res.headersSent) {
            console.error(`Error generating delivered zip for collection ${collection.id} (streaming already started):`, archiveError.message);
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
    } catch (error) {
        console.error(`Error marking collection with id ${id} as viewed:`, error);
        throw error;
    }
};