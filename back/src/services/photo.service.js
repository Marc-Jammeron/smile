import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { generateDerivedImages } from "./image-processing.service.js";
import { isMainPhotoFilename, isBlacklistedFilename } from "./filename.util.js";

// Attachments (RAW/XMP) are opaque past this gate: once accepted, they're never
// re-classified by format anywhere else in the codebase (see spec's "no re-render"
// principle). Collection statuses only, per the reviewed decision — Photo status is
// irrelevant here.
const ATTACHMENT_ALLOWED_COLLECTION_STATUSES = ['DRAFT', 'SELECTING', 'EDITING'];

const assertCollectionAcceptsAttachments = async (collectionId) => {
    const collection = await db.Collection.findByPk(collectionId);
    if (!ATTACHMENT_ALLOWED_COLLECTION_STATUSES.includes(collection?.status)) {
        const error = new Error('Attachments can only be uploaded while the collection is in DRAFT, SELECTING or EDITING status');
        error.status = 409;
        throw error;
    }
};

const toPhotoDTO = async (photo) => {
    const { key, thumbnailKey, previewKey } = photo;
    const [url, thumbnailUrl, previewUrl] = await Promise.all([
        s3Repository.getSignedDownloadUrl(key),
        thumbnailKey ? s3Repository.getSignedDownloadUrl(thumbnailKey) : Promise.resolve(null),
        previewKey ? s3Repository.getSignedDownloadUrl(previewKey) : Promise.resolve(null)
    ]);
    return { ...photo.toJSON(), url, thumbnailUrl, previewUrl };
};

// Client-facing DTO: unlike toPhotoDTO, `url` is presigned on previewKey (never key),
// and the raw `key` (original's S3 path) is stripped from the payload entirely,
// so the client gallery never leaks the original HD file, signed or not.
const toClientPhotoDTO = async (photo) => {
    const { thumbnailKey, previewKey } = photo;
    const [url, thumbnailUrl, previewUrl] = await Promise.all([
        previewKey ? s3Repository.getSignedDownloadUrl(previewKey) : Promise.resolve(null),
        thumbnailKey ? s3Repository.getSignedDownloadUrl(thumbnailKey) : Promise.resolve(null),
        previewKey ? s3Repository.getSignedDownloadUrl(previewKey) : Promise.resolve(null)
    ]);
    const { key, ...photoWithoutKey } = photo.toJSON();
    return { ...photoWithoutKey, url, thumbnailUrl, previewUrl };
};

export const getAllPhotosByCollectionId = async (collectionId) => {
    try {
        const photos = await db.Photo.findAll({
            where: {
                collectionId,
                status: ['PENDING', 'SELECTED', 'REJECTED', 'DELIVERED'],
            },
        });
        return Promise.all(photos.map(toPhotoDTO));
    } catch (error) {
        console.error(`Error fetching photos for collection with id ${collectionId}:`, error);
        throw error;
    }
};

export const getAllClientPhotosByCollectionId = async (collectionId) => {
    try {
        const photos = await db.Photo.findAll({
            where: {
                collectionId,
                status: ['PENDING', 'SELECTED', 'REJECTED'],
            },
        });
        return Promise.all(photos.map(toClientPhotoDTO));
    } catch (error) {
        console.error(`Error fetching client photos for collection with id ${collectionId}:`, error);
        throw error;
    }
};

export const getPhotoById = async (id) => {
    try {
        const photo = await db.Photo.findByPk(id);
        return photo ? toPhotoDTO(photo) : null;
    } catch (error) {
        console.error(`Error fetching photo with id ${id}:`, error);
        throw error;
    }
};

const assertCollectionInEditingStatus = async (collectionId) => {
    const collection = await db.Collection.findByPk(collectionId);
    if (collection?.status !== 'EDITING') {
        const error = new Error("Collection must be in EDITING status to upload DELIVERED photos");
        error.status = 409;
        throw error;
    }
};

export const createPhotosBatch = async ({ collectionId, files, targetStatus = 'PENDING' }) => {
    try {
        if (targetStatus === 'DELIVERED') {
            await assertCollectionInEditingStatus(collectionId);
        }
        if (files.some((file) => file.type === 'attachment')) {
            await assertCollectionAcceptsAttachments(collectionId);
        }
        return await Promise.all(files.map(async ({ filename, contentType, type = 'photo' }) => {
            if (isBlacklistedFilename(filename)) {
                const error = new Error(`File ${filename} is not a valid upload target`);
                error.status = 400;
                throw error;
            }
            const { url, key } = type === 'attachment'
                ? await s3Repository.getSignedAttachmentUploadUrl(collectionId, filename, contentType)
                : await s3Repository.getSignedUploadUrl(collectionId, filename, contentType);
            return { filename, url, key };
        }));
    } catch (error) {
        console.error("Error generating signed upload urls:", error);
        throw error;
    }
};

// Attachments never reach generateDerivedImages/sharp: they're persisted as-is,
// restituted as-is at delivery, with no format-specific logic anywhere (spec's
// "opaque attachment" principle).
const confirmAttachment = async (attachmentData, photoId) => {
    const { key, contentType, size, filename } = attachmentData;

    if (isBlacklistedFilename(filename, size)) {
        const error = new Error(`File ${filename} is not a valid attachment`);
        error.status = 400;
        throw error;
    }

    const exists = await s3Repository.objectExists(key);
    if (!exists) {
        const error = new Error(`Object with key ${key} not found in storage`);
        error.status = 400;
        throw error;
    }

    const attachment = await db.PhotoAttachment.create({
        photoId,
        originalFilename: filename,
        s3Key: key,
        fileSize: size,
        mimeType: contentType
    });
    return attachment.toJSON();
};

const confirmAttachmentForExistingPhoto = async (attachmentData, photoId) => {
    const photo = await db.Photo.findByPk(photoId);
    if (!photo) {
        const error = new Error(`Photo ${photoId} not found`);
        error.status = 404;
        throw error;
    }
    await assertCollectionAcceptsAttachments(photo.collectionId);
    return confirmAttachment(attachmentData, photoId);
};

// Extension is checked here (not just at grouping time on the client) so a CR2
// submitted as a main photo item can never reach generateDerivedImages/sharp.
const confirmPhoto = async (photoData, targetStatus) => {
    try {
        const { collectionId, key, contentType, size, description, filename, attachments = [] } = photoData;

        if (!isMainPhotoFilename(filename)) {
            const error = new Error(`File ${filename} is not a supported main photo format (expected .jpg/.jpeg)`);
            error.status = 400;
            throw error;
        }

        const exists = await s3Repository.objectExists(key);
        if (!exists) {
            const error = new Error(`Object with key ${key} not found in storage`);
            error.status = 400;
            throw error;
        }

        if (attachments.length > 0) {
            await assertCollectionAcceptsAttachments(collectionId);
        }

        const { thumbnailKey, previewKey } = await generateDerivedImages(key, { watermark: targetStatus !== 'DELIVERED' });

        const newPhoto = await db.Photo.create({ collectionId, key, thumbnailKey, previewKey, contentType, size, description, originalFilename: filename, status: targetStatus });

        const attachmentResults = await Promise.allSettled(
            attachments.map((attachmentData) => confirmAttachment(attachmentData, newPhoto.id))
        );
        const failedAttachments = attachmentResults
            .map((result, index) => result.status === 'rejected' ? { key: attachments[index].key, error: result.reason.message } : null)
            .filter(Boolean);

        const photoDTO = await toPhotoDTO(newPhoto);
        return { ...photoDTO, failedAttachments };
    } catch (error) {
        console.error("Error confirming photo:", error);
        throw error;
    }
};

export const confirmPhotosBatch = async ({ photos = [], attachmentsToExistingPhotos = [], targetStatus = 'PENDING' }) => {
    if (targetStatus === 'DELIVERED' && photos.length > 0) {
        await assertCollectionInEditingStatus(photos[0].collectionId);
    }

    const photoResults = await Promise.allSettled(photos.map((photoData) => confirmPhoto(photoData, targetStatus)));

    const created = [];
    const failed = [];
    const failedAttachments = [];
    photoResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            const { failedAttachments: photoFailedAttachments, ...photoDTO } = result.value;
            created.push(photoDTO);
            failedAttachments.push(...photoFailedAttachments.map((attachmentFailure) => ({ ...attachmentFailure, photoId: photoDTO.id })));
        } else {
            failed.push({ key: photos[index].key, error: result.reason.message });
        }
    });

    const existingAttachmentTasks = attachmentsToExistingPhotos.flatMap(({ photoId, attachments }) =>
        attachments.map((attachmentData) => ({ photoId, attachmentData }))
    );
    const existingAttachmentResults = await Promise.allSettled(
        existingAttachmentTasks.map(({ photoId, attachmentData }) => confirmAttachmentForExistingPhoto(attachmentData, photoId))
    );
    const createdAttachments = [];
    existingAttachmentResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            createdAttachments.push(result.value);
        } else {
            failedAttachments.push({ key: existingAttachmentTasks[index].attachmentData.key, error: result.reason.message });
        }
    });

    return { created, failed, createdAttachments, failedAttachments };
};

const assertCollectionInSelectionStatus = async (photo) => {
    const collection = await db.Collection.findByPk(photo.collectionId);
    if (collection?.status !== 'SELECTING') {
        const error = new Error('Photo status can only be changed to SELECTED or REJECTED while the collection is in SELECTING status');
        error.status = 400;
        throw error;
    }
};

export const updatePhoto = async (id, photoData) => {
    try {
        const { description, status } = photoData;

        if (status === 'SELECTED' || status === 'REJECTED') {
            const photo = await db.Photo.findByPk(id);
            if (!photo) {
                return false;
            }
            await assertCollectionInSelectionStatus(photo);
        }

        const [updatedRows] = await db.Photo.update({ description, status }, {
            where: { id }
        });
        return updatedRows > 0;
    } catch (error) {
        console.error(`Error updating photo with id ${id}:`, error);
        throw error;
    }
};

export const updatePhotoSelectionStatus = async (id, status) => {
    try {
        if (status !== 'SELECTED' && status !== 'REJECTED') {
            const error = new Error("Status must be either 'SELECTED' or 'REJECTED'");
            error.status = 400;
            throw error;
        }

        const photo = await db.Photo.findByPk(id);
        if (!photo) {
            return false;
        }
        await assertCollectionInSelectionStatus(photo);

        const [updatedRows] = await db.Photo.update({ status }, {
            where: { id }
        });
        return updatedRows > 0;
    } catch (error) {
        console.error(`Error updating selection status for photo with id ${id}:`, error);
        throw error;
    }
};

export const getSelectedPhotosForCollection = async (collectionId) => {
    try {
        return await db.Photo.findAll({
            where: { collectionId, status: 'SELECTED' }
        });
    } catch (error) {
        console.error(`Error fetching selected photos for collection with id ${collectionId}:`, error);
        throw error;
    }
};

// Raw DB rows, grouped by photoId, for streaming attachments into a ZIP (or for
// collecting their s3Keys before a cascading Photo delete cleans up S3 objects).
export const getAttachmentsForPhotos = async (photoIds, options = {}) => {
    if (photoIds.length === 0) {
        return [];
    }
    try {
        return await db.PhotoAttachment.findAll({
            where: { photoId: photoIds },
            ...options
        });
    } catch (error) {
        console.error(`Error fetching attachments for photos ${photoIds.join(', ')}:`, error);
        throw error;
    }
};

// Raw DB rows (not a presigned DTO), for streaming originals into a ZIP.
export const getDeliveredPhotosForZip = async (collectionId) => {
    try {
        return await db.Photo.findAll({
            where: { collectionId, status: 'DELIVERED' }
        });
    } catch (error) {
        console.error(`Error fetching delivered photos for collection with id ${collectionId}:`, error);
        throw error;
    }
};

// Photos created before the originalFilename column existed don't have it populated:
// fall back to deriving a readable name from `key` (`uploads/<collectionId>/<uuid>-<filename>`).
const UUID_PREFIX_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

export const getPhotoDownloadFilename = (photo) => {
    if (photo.originalFilename) {
        return photo.originalFilename;
    }
    const basename = photo.key.split('/').pop();
    return basename.replace(UUID_PREFIX_PATTERN, '');
};

export const countSelectedPhotos = async (collectionId) => {
    try {
        return await db.Photo.count({
            where: { collectionId, status: 'SELECTED' }
        });
    } catch (error) {
        console.error(`Error counting selected photos for collection with id ${collectionId}:`, error);
        throw error;
    }
};

export const softDeletePhoto = async (id) => {
    try {
        const [updatedRows] = await db.Photo.update({ status: 'ARCHIVED' }, {
            where: { id }
        });
        return updatedRows > 0;
    } catch (error) {
        console.error(`Error soft deleting photo with id ${id}:`, error);
        throw error;
    }
};

// Unlike getAllClientPhotosByCollectionId (toClientPhotoDTO, which strips `key` and
// never presigns it), DELIVERED photos are the final hi-res delivery: the client is
// meant to download the full-resolution file, so `url` is intentionally presigned on
// `key` here via toPhotoDTO (same DTO as the admin-facing listing).
export const getDeliveredPhotosByCollectionId = async (collectionId) => {
    try {
        const photos = await db.Photo.findAll({
            where: {
                collectionId,
                status: 'DELIVERED',
            },
        });
        return Promise.all(photos.map(toPhotoDTO));
    } catch (error) {
        console.error(`Error fetching delivered photos for collection with id ${collectionId}:`, error);
        throw error;
    }
};

// Hard delete of a DELIVERED photo (re-upload correction before mark-ready). Unlike
// softDeletePhoto, this removes the DB row and the S3 objects: DELIVERED photos are
// never surfaced to the client through the normal PENDING/SELECTED/REJECTED flow, so
// there's no soft-delete/undo expectation for them the way there is for other statuses.
export const deleteDeliveredPhoto = async (id) => {
    try {
        const photo = await db.Photo.findByPk(id);
        if (!photo) {
            return null;
        }
        if (photo.status !== 'DELIVERED') {
            const error = new Error('Only DELIVERED photos can be deleted through this endpoint');
            error.status = 403;
            throw error;
        }

        const attachments = await getAttachmentsForPhotos([photo.id]);
        const keys = [photo.key, photo.thumbnailKey, photo.previewKey, ...attachments.map((attachment) => attachment.s3Key)].filter(Boolean);
        await Promise.all(keys.map((key) => s3Repository.deleteObject(key)));

        // DB-level ON DELETE CASCADE (see PhotoAttachments migration) removes the
        // attachment rows; only their S3 objects needed collecting above.
        await db.Photo.destroy({ where: { id } });
        return true;
    } catch (error) {
        console.error(`Error deleting delivered photo with id ${id}:`, error);
        throw error;
    }
};