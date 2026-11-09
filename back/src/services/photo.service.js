import db from "../repository/db.repository.js";
import s3Repository from "../repository/s3.repository.js";
import { generateDerivedImages } from "./image-processing.service.js";
import { loadWatermarkConfig } from "./settings.service.js";
import { createLimiter, once } from "../utils/limiter.js";
import { isMainPhotoFilename, isBlacklistedFilename } from "./filename.util.js";
import { LIMITS } from "../config/limits.js";
import { SIGNED_URL_TTL_SECONDS } from "../config/signed-urls.js";
import logger from "../logger.js";

const log = logger.child("photo.service");

// Process-wide bound on concurrent image processing (decode + resize + encode): it holds
// across requests, so a client retrying after a timeout cannot pile work on top of the
// request it abandoned.
const imageProcessingLimit = createLimiter(LIMITS.imageProcessingConcurrency);

// Attachments (RAW/XMP) are opaque past this gate: once accepted, they're never
// re-classified by format anywhere else in the codebase (see spec's "no re-render"
// principle). Collection statuses only, per the reviewed decision — Photo status is
// irrelevant here.
const ATTACHMENT_ALLOWED_COLLECTION_STATUSES = ['DRAFT', 'SELECTING', 'EDITING'];

const assertCollectionAcceptsAttachments = async (collectionId) => {
    const collection = await db.Collection.findByPk(collectionId);
    if (!ATTACHMENT_ALLOWED_COLLECTION_STATUSES.includes(collection?.status)) {
        log.warn("Attachment refused: collection status does not allow it", { collectionId, status: collection?.status ?? null });
        const error = new Error('Attachments can only be uploaded while the collection is in DRAFT, SELECTING or EDITING status');
        error.status = 409;
        throw error;
    }
};

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const UPLOAD_KEY_PREFIX = 'uploads';
const ATTACHMENT_KEY_PREFIX = 'attachments';

// Keys are minted by this server (`<prefix>/<collectionId>/<uuid>-<filename>`): a key that
// does not live under its own collection's prefix was never issued for it.
const assertKeyBelongsToCollection = (key, prefix, collectionId) => {
    if (typeof key !== 'string' || typeof collectionId !== 'string' || !key.startsWith(`${prefix}/${collectionId}/`)) {
        log.warn("Refused: key does not belong to the collection", { collectionId, key: typeof key === 'string' ? key : null, prefix });
        throw badRequest(`Key ${typeof key === 'string' ? key : '(invalid)'} does not belong to collection ${collectionId}`);
    }
};

const assertOptionalArray = (value, name) => {
    if (value !== undefined && !Array.isArray(value)) {
        throw badRequest(`${name} must be an array`);
    }
};

const assertPresignRequest = ({ collectionId, files }) => {
    if (typeof collectionId !== 'string' || collectionId === '') {
        throw badRequest('collectionId is required');
    }
    if (!Array.isArray(files)) {
        throw badRequest('files must be an array');
    }
    if (files.length > LIMITS.maxPresignFiles) {
        log.warn("Presign refused: too many files", { collectionId, fileCount: files.length, max: LIMITS.maxPresignFiles });
        throw badRequest(`Too many files in one upload request (${files.length}, max ${LIMITS.maxPresignFiles})`);
    }
    if (files.some((file) => file === null || typeof file !== 'object')) {
        throw badRequest('Each file must be an object');
    }
};

const assertConfirmRequest = ({ photos, attachmentsToExistingPhotos }) => {
    assertOptionalArray(photos, 'photos');
    assertOptionalArray(attachmentsToExistingPhotos, 'attachmentsToExistingPhotos');
    const photoList = photos ?? [];
    const existingList = attachmentsToExistingPhotos ?? [];

    if (photoList.length > LIMITS.maxConfirmPhotos) {
        log.warn("Confirm refused: too many photos", { photoCount: photoList.length, max: LIMITS.maxConfirmPhotos });
        throw badRequest(`Too many photos in one confirm request (${photoList.length}, max ${LIMITS.maxConfirmPhotos})`);
    }
    if ([...photoList, ...existingList].some((item) => item === null || typeof item !== 'object')) {
        throw badRequest('Each photo and attachment group must be an object');
    }
    for (const item of [...photoList, ...existingList]) {
        assertOptionalArray(item.attachments, 'attachments');
    }
    if (existingList.some((item) => !Array.isArray(item.attachments))) {
        throw badRequest('attachments must be an array');
    }

    const attachmentCount = [...photoList, ...existingList].reduce((sum, item) => sum + (item.attachments?.length ?? 0), 0);
    if (attachmentCount > LIMITS.maxConfirmAttachments) {
        log.warn("Confirm refused: too many attachments", { attachmentCount, max: LIMITS.maxConfirmAttachments });
        throw badRequest(`Too many attachments in one confirm request (${attachmentCount}, max ${LIMITS.maxConfirmAttachments})`);
    }
};

const PHOTO_ORDER = [['position', 'ASC'], ['id', 'ASC']];

const toPhotoDTO = async (photo) => {
    const { key, thumbnailKey, previewKey } = photo;
    const [url, thumbnailUrl, previewUrl] = await Promise.all([
        s3Repository.getSignedDownloadUrl(key, { expiresIn: SIGNED_URL_TTL_SECONDS.original }),
        thumbnailKey ? s3Repository.getSignedDownloadUrl(thumbnailKey, { expiresIn: SIGNED_URL_TTL_SECONDS.preview }) : Promise.resolve(null),
        previewKey ? s3Repository.getSignedDownloadUrl(previewKey, { expiresIn: SIGNED_URL_TTL_SECONDS.preview }) : Promise.resolve(null)
    ]);
    return { ...photo.toJSON(), url, thumbnailUrl, previewUrl };
};

// Client-facing DTO: unlike toPhotoDTO, `url` is presigned on previewKey (never key),
// and the raw `key` (original's S3 path) is stripped from the payload entirely,
// so the client gallery never leaks the original HD file, signed or not.
const toClientPhotoDTO = async (photo) => {
    const { thumbnailKey, previewKey } = photo;
    const previewTtl = { expiresIn: SIGNED_URL_TTL_SECONDS.preview };
    const [url, thumbnailUrl, previewUrl] = await Promise.all([
        previewKey ? s3Repository.getSignedDownloadUrl(previewKey, previewTtl) : Promise.resolve(null),
        thumbnailKey ? s3Repository.getSignedDownloadUrl(thumbnailKey, previewTtl) : Promise.resolve(null),
        previewKey ? s3Repository.getSignedDownloadUrl(previewKey, previewTtl) : Promise.resolve(null)
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
            order: PHOTO_ORDER,
        });
        log.debug("Photos loaded", { collectionId, count: photos.length });
        return Promise.all(photos.map(toPhotoDTO));
    } catch (error) {
        log.failure("Error fetching photos", error, { collectionId });
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
            order: PHOTO_ORDER,
        });
        return Promise.all(photos.map(toClientPhotoDTO));
    } catch (error) {
        log.failure("Error fetching client photos", error, { collectionId });
        throw error;
    }
};

export const getPhotoById = async (id) => {
    try {
        const photo = await db.Photo.findByPk(id);
        return photo ? toPhotoDTO(photo) : null;
    } catch (error) {
        log.failure("Error fetching photo", error, { photoId: id });
        throw error;
    }
};

const assertCollectionInEditingStatus = async (collectionId) => {
    const collection = await db.Collection.findByPk(collectionId);
    if (collection?.status !== 'EDITING') {
        log.warn("DELIVERED upload refused: collection is not in EDITING status", { collectionId, status: collection?.status ?? null });
        const error = new Error("Collection must be in EDITING status to upload DELIVERED photos");
        error.status = 409;
        throw error;
    }
};

export const createPhotosBatch = async ({ collectionId, files, targetStatus = 'PENDING' } = {}) => {
    try {
        assertPresignRequest({ collectionId, files });
        log.debug("Creating upload urls", { collectionId, targetStatus, fileCount: files.length });
        if (targetStatus === 'DELIVERED') {
            await assertCollectionInEditingStatus(collectionId);
        }
        if (files.some((file) => file.type === 'attachment')) {
            await assertCollectionAcceptsAttachments(collectionId);
        }
        return await Promise.all(files.map(async ({ filename, contentType, type = 'photo' }) => {
            if (isBlacklistedFilename(filename)) {
                log.warn("Upload refused: blacklisted filename", { collectionId, filename });
                const error = new Error(`File ${filename} is not a valid upload target`);
                error.status = 400;
                throw error;
            }
            const { url, key } = type === 'attachment'
                ? await s3Repository.getSignedAttachmentUploadUrl(collectionId, filename, contentType)
                : await s3Repository.getSignedUploadUrl(collectionId, filename, contentType);
            log.debug("Upload url created", { collectionId, filename, key, type });
            return { filename, url, key };
        }));
    } catch (error) {
        log.failure("Error generating signed upload urls", error);
        throw error;
    }
};

// Attachments never reach generateDerivedImages/sharp: they're persisted as-is,
// restituted as-is at delivery, with no format-specific logic anywhere (spec's
// "opaque attachment" principle).
const confirmAttachment = async (attachmentData, photoId, collectionId) => {
    const { key, contentType, size, filename } = attachmentData;

    assertKeyBelongsToCollection(key, ATTACHMENT_KEY_PREFIX, collectionId);

    if (isBlacklistedFilename(filename, size)) {
        log.warn("Attachment refused: blacklisted filename or size", { photoId, filename, size });
        const error = new Error(`File ${filename} is not a valid attachment`);
        error.status = 400;
        throw error;
    }

    const exists = await s3Repository.objectExists(key);
    if (!exists) {
        log.warn("Attachment confirmation refused: object missing in storage", { photoId, key });
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
    log.info("Attachment saved", { photoId, attachmentId: attachment.id, filename, size });
    return attachment.toJSON();
};

const confirmAttachmentForExistingPhoto = async (attachmentData, photoId) => {
    const photo = await db.Photo.findByPk(photoId);
    if (!photo) {
        log.warn("Attachment target photo not found", { photoId });
        const error = new Error(`Photo ${photoId} not found`);
        error.status = 404;
        throw error;
    }
    await assertCollectionAcceptsAttachments(photo.collectionId);
    return confirmAttachment(attachmentData, photoId, photo.collectionId);
};

// Extension is checked here (not just at grouping time on the client) so a CR2
// submitted as a main photo item can never reach generateDerivedImages/sharp.
const confirmPhoto = async (photoData, targetStatus, position, { getWatermarkConfig, signal } = {}) => {
    try {
        const { collectionId, key, contentType, size, description, filename, attachments = [] } = photoData;

        log.debug("Confirming photo", { collectionId, key, filename, size, targetStatus, position, attachmentCount: attachments.length });

        assertKeyBelongsToCollection(key, UPLOAD_KEY_PREFIX, collectionId);

        if (!isMainPhotoFilename(filename)) {
            log.warn("Photo refused: unsupported main photo format", { collectionId, filename });
            const error = new Error(`File ${filename} is not a supported main photo format (expected .jpg/.jpeg)`);
            error.status = 400;
            throw error;
        }

        const exists = await s3Repository.objectExists(key);
        if (!exists) {
            log.warn("Photo refused: uploaded object missing in storage", { collectionId, key });
            const error = new Error(`Object with key ${key} not found in storage`);
            error.status = 400;
            throw error;
        }

        if (attachments.length > 0) {
            await assertCollectionAcceptsAttachments(collectionId);
        }

        const watermarked = targetStatus !== 'DELIVERED';
        const queuedAt = performance.now();
        const { thumbnailKey, previewKey } = await imageProcessingLimit(async () => {
            // Checked once the slot is ours: a photo that waited while the client left is skipped.
            if (signal?.aborted) {
                log.info("Photo skipped: the request was aborted by the client", { collectionId, key });
                throw Object.assign(new Error('Request aborted by the client'), { status: 499 });
            }
            log.debug("Image processing slot acquired", { key, waitMs: Math.round(performance.now() - queuedAt), ...imageProcessingLimit.stats() });
            const watermarkConfig = watermarked ? await getWatermarkConfig() : undefined;
            return generateDerivedImages(key, { watermark: watermarked, watermarkConfig });
        });

        log.debug("Derived images generated", { key, thumbnailKey, previewKey, watermarked });

        const newPhoto = await db.Photo.create({ collectionId, key, thumbnailKey, previewKey, contentType, size, description, originalFilename: filename, status: targetStatus, position });

        const attachmentResults = await Promise.allSettled(
            attachments.map((attachmentData) => confirmAttachment(attachmentData, newPhoto.id, collectionId))
        );
        const failedAttachments = attachmentResults
            .map((result, index) => result.status === 'rejected' ? { key: attachments[index].key, error: result.reason.message } : null)
            .filter(Boolean);

        if (failedAttachments.length > 0) {
            log.warn("Photo created but some attachments failed", { photoId: newPhoto.id, failedAttachments });
        }
        log.info("Photo created", { photoId: newPhoto.id, collectionId, filename, status: targetStatus, position, attachmentCount: attachments.length - failedAttachments.length });

        const photoDTO = await toPhotoDTO(newPhoto);
        return { ...photoDTO, failedAttachments };
    } catch (error) {
        log.failure("Error confirming photo", error, { key: photoData?.key, collectionId: photoData?.collectionId });
        throw error;
    }
};

const getNextPosition = async (collectionId) => {
    const maxPosition = await db.Photo.max('position', { where: { collectionId } });
    return Number.isFinite(maxPosition) ? maxPosition + 1 : 0;
};

export const confirmPhotosBatch = async ({ photos = [], attachmentsToExistingPhotos = [], targetStatus = 'PENDING', signal } = {}) => {
    assertConfirmRequest({ photos, attachmentsToExistingPhotos });

    if (targetStatus === 'DELIVERED' && photos.length > 0) {
        await assertCollectionInEditingStatus(photos[0].collectionId);
    }

    // Positions come from the order of `photos` (the client sends them sorted), not
    // from the order the parallel confirmations finish. The base continues after the
    // collection's existing photos; chunks of one upload are confirmed sequentially,
    // so each chunk's base picks up where the previous one ended.
    const basePosition = photos.length > 0 ? await getNextPosition(photos[0].collectionId) : 0;
    log.debug("Confirming photo batch", { photoCount: photos.length, attachmentsToExistingPhotos: attachmentsToExistingPhotos.length, targetStatus, basePosition });

    // Resolved at most once per request (lazily, so a batch whose photos are all refused
    // never pays for it, and a DELIVERED batch never calls it). A failure is shared: every
    // watermarked photo of the batch reports the same error in `failed`.
    const getWatermarkConfig = once(loadWatermarkConfig);
    const photoResults = await Promise.allSettled(
        photos.map((photoData, index) => confirmPhoto(photoData, targetStatus, basePosition + index, { getWatermarkConfig, signal }))
    );

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
            log.failure("Attachment of an existing photo could not be confirmed", result.reason, { photoId: existingAttachmentTasks[index].photoId, key: existingAttachmentTasks[index].attachmentData.key });
            failedAttachments.push({ key: existingAttachmentTasks[index].attachmentData.key, error: result.reason.message });
        }
    });

    return { created, failed, createdAttachments, failedAttachments };
};

const assertCollectionInSelectionStatus = async (photo) => {
    const collection = await db.Collection.findByPk(photo.collectionId);
    if (collection?.status !== 'SELECTING') {
        log.warn("Selection change refused: collection is not in SELECTING status", { photoId: photo.id, collectionId: photo.collectionId, status: collection?.status ?? null });
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
                log.debug("Photo to update not found", { photoId: id });
                return false;
            }
            await assertCollectionInSelectionStatus(photo);
        }

        const [updatedRows] = await db.Photo.update({ description, status }, {
            where: { id }
        });
        log.debug("Photo update done", { photoId: id, updatedRows, status });
        return updatedRows > 0;
    } catch (error) {
        log.failure("Error updating photo", error, { photoId: id });
        throw error;
    }
};

export const updatePhotoSelectionStatus = async (id, status) => {
    try {
        if (status !== 'SELECTED' && status !== 'REJECTED') {
            log.warn("Invalid selection status refused", { photoId: id, status });
            const error = new Error("Status must be either 'SELECTED' or 'REJECTED'");
            error.status = 400;
            throw error;
        }

        const photo = await db.Photo.findByPk(id);
        if (!photo) {
            log.debug("Photo for selection change not found", { photoId: id });
            return false;
        }
        await assertCollectionInSelectionStatus(photo);

        const [updatedRows] = await db.Photo.update({ status }, {
            where: { id }
        });
        log.debug("Photo selection status updated", { photoId: id, status, previousStatus: photo.status });
        return updatedRows > 0;
    } catch (error) {
        log.failure("Error updating photo selection status", error, { photoId: id });
        throw error;
    }
};

export const getSelectedPhotosForCollection = async (collectionId) => {
    try {
        return await db.Photo.findAll({
            where: { collectionId, status: 'SELECTED' },
            order: PHOTO_ORDER
        });
    } catch (error) {
        log.failure("Error fetching selected photos", error, { collectionId });
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
        log.failure("Error fetching attachments", error, { photoIds });
        throw error;
    }
};

// Raw DB rows (not a presigned DTO), for streaming originals into a ZIP.
export const getDeliveredPhotosForZip = async (collectionId) => {
    try {
        return await db.Photo.findAll({
            where: { collectionId, status: 'DELIVERED' },
            order: PHOTO_ORDER
        });
    } catch (error) {
        log.failure("Error fetching delivered photos", error, { collectionId });
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
        log.failure("Error counting selected photos", error, { collectionId });
        throw error;
    }
};

export const softDeletePhoto = async (id) => {
    try {
        const [updatedRows] = await db.Photo.update({ status: 'ARCHIVED' }, {
            where: { id }
        });
        log.debug("Photo archived", { photoId: id, updatedRows });
        return updatedRows > 0;
    } catch (error) {
        log.failure("Error soft deleting photo", error, { photoId: id });
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
            order: PHOTO_ORDER,
        });
        return Promise.all(photos.map(toPhotoDTO));
    } catch (error) {
        log.failure("Error fetching delivered photos", error, { collectionId });
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
            log.debug("Delivered photo to delete not found", { photoId: id });
            return null;
        }
        if (photo.status !== 'DELIVERED') {
            log.warn("Hard delete refused: photo is not DELIVERED", { photoId: id, status: photo.status });
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
        log.info("Delivered photo and its files deleted", { photoId: id, collectionId: photo.collectionId, deletedObjects: keys.length });
        return true;
    } catch (error) {
        log.failure("Error deleting delivered photo", error, { photoId: id });
        throw error;
    }
};