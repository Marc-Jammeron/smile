import logger from '../logger.js';
import { getAllPhotosByCollectionId, getPhotoById, createPhotosBatch, confirmPhotosBatch, updatePhoto, updatePhotoSelectionStatus, softDeletePhoto, deleteDeliveredPhoto } from '../services/photo.service.js';

const log = logger.child('photo.controller');

export const getPhotosByCollectionId = async (req, res) => {
    const { collectionId } = req.params;
    try {
        const photos = await getAllPhotosByCollectionId(collectionId);
        log.debug('Photos listed', { collectionId, count: photos.length });
        res.json(photos);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch photos' });
    }
};

export const getPhoto = async (req, res) => {
    const { id } = req.params;
    try {
        const photo = await getPhotoById(id);
        if (photo) {
            log.debug('Photo fetched', { photoId: id });
            res.json(photo);
        } else {
            log.warn('Photo not found', { photoId: id });
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch photo' });
    }
};

export const createNewPhotosBatch = async (req, res) => {
    try {
        const { collectionId, files, targetStatus } = req.body ?? {};
        log.info('Generating upload urls', { collectionId, fileCount: files?.length, targetStatus });
        const urls = await createPhotosBatch(req.body);
        res.status(200).json(urls);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to generate upload urls' });
    }
};

export const confirmNewPhotosBatch = async (req, res) => {
    try {
        const { photos, attachmentsToExistingPhotos, targetStatus } = req.body;
        log.info('Confirming uploaded photos', {
            photoCount: photos?.length,
            attachmentsToExistingPhotosCount: attachmentsToExistingPhotos?.length,
            targetStatus
        });
        const result = await confirmPhotosBatch({ photos, attachmentsToExistingPhotos, targetStatus });
        const summary = {
            created: result.created.length,
            failed: result.failed.length,
            createdAttachments: result.createdAttachments.length,
            failedAttachments: result.failedAttachments.length
        };
        if (summary.failed > 0 || summary.failedAttachments > 0) {
            log.warn('Photo batch confirmed with failures', { ...summary, failures: result.failed, failedAttachments: result.failedAttachments });
        } else {
            log.info('Photo batch confirmed', summary);
        }
        res.status(201).json(result);
    } catch (error) {
        log.failure('Failed to confirm photos', error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to confirm photos' });
    }
};

export const updateExistingPhoto = async (req, res) => {
    const { id } = req.params;
    try {
        const updated = await updatePhoto(id, req.body);
        if (updated) {
            log.info('Photo updated', { photoId: id, fields: Object.keys(req.body ?? {}) });
            res.json({ message: 'Photo updated successfully' });
        } else {
            log.warn('Photo to update not found', { photoId: id });
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update photo' });
    }
};

export const updatePhotoSelection = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const updated = await updatePhotoSelectionStatus(id, status);
        if (updated) {
            log.info('Photo selection status updated', { photoId: id, status });
            res.json({ message: 'Photo selection status updated successfully' });
        } else {
            log.warn('Photo selection target not found', { photoId: id });
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update photo selection status' });
    }
};

export const softDeletePhotoById = async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await softDeletePhoto(id);
        if (deleted) {
            log.info('Photo soft deleted', { photoId: id });
            res.json({ message: 'Photo soft deleted successfully' });
        } else {
            log.warn('Photo to soft delete not found', { photoId: id });
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to soft delete photo' });
    }
};

export const deleteDeliveredPhotoById = async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await deleteDeliveredPhoto(id);
        if (deleted === null) {
            log.warn('Delivered photo to delete not found', { photoId: id });
            res.status(404).json({ error: 'Photo not found' });
        } else {
            log.info('Delivered photo deleted', { photoId: id });
            res.json({ message: 'Delivered photo deleted successfully' });
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to delete delivered photo' });
    }
};