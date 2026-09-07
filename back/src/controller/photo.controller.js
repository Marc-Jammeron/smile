import { getAllPhotosByCollectionId, getPhotoById, createPhotosBatch, confirmPhotosBatch, updatePhoto, updatePhotoSelectionStatus, softDeletePhoto, deleteDeliveredPhoto } from '../services/photo.service.js';

export const getPhotosByCollectionId = async (req, res) => {
    const { collectionId } = req.params;
    try {
        const photos = await getAllPhotosByCollectionId(collectionId);
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
            res.json(photo);
        } else {
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch photo' });
    }
};

export const createNewPhotosBatch = async (req, res) => {
    try {
        const urls = await createPhotosBatch(req.body);
        res.status(200).json(urls);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to generate upload urls' });
    }
};

export const confirmNewPhotosBatch = async (req, res) => {
    try {
        const { photos, attachmentsToExistingPhotos, targetStatus } = req.body;
        const result = await confirmPhotosBatch({ photos, attachmentsToExistingPhotos, targetStatus });
        res.status(201).json(result);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to confirm photos' });
    }
};

export const updateExistingPhoto = async (req, res) => {
    const { id } = req.params;
    try {
        const updated = await updatePhoto(id, req.body);
        if (updated) {
            res.json({ message: 'Photo updated successfully' });
        } else {
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
            res.json({ message: 'Photo selection status updated successfully' });
        } else {
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
            res.json({ message: 'Photo soft deleted successfully' });
        } else {
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
            res.status(404).json({ error: 'Photo not found' });
        } else {
            res.json({ message: 'Delivered photo deleted successfully' });
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to delete delivered photo' });
    }
};