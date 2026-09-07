import { getAllClientPhotosByCollectionId, getDeliveredPhotosByCollectionId, updatePhotoSelectionStatus } from '../services/photo.service.js';
import { markCollectionAsViewed, streamDeliveredZip } from '../services/collection.service.js';
import { validateCollectionSelection } from '../services/client.service.js';

export const getClientGallery = async (req, res) => {
    try {
        if (!req.collection.viewedByCustomer) {
            await markCollectionAsViewed(req.collection.id);
        }
        const photos = req.collection.status === 'READY'
            ? await getDeliveredPhotosByCollectionId(req.collection.id)
            : await getAllClientPhotosByCollectionId(req.collection.id);
        res.json({ collection: req.collection, photos, photographerName: process.env.PHOTOGRAPHER_DISPLAY_NAME || null });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch gallery' });
    }
};

export const downloadAllDeliveredPhotos = async (req, res) => {
    try {
        await streamDeliveredZip(req.collection, res);
    } catch (error) {
        if (res.headersSent) {
            console.error(`Error generating delivered zip for collection ${req.collection.id}:`, error.message);
            return;
        }
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors de la génération du ZIP' });
    }
};

export const updateClientPhotoSelection = async (req, res) => {
    const { photoId } = req.params;
    const { status } = req.body;
    try {
        const updated = await updatePhotoSelectionStatus(photoId, status);
        if (updated) {
            res.json({ message: 'Photo selection status updated successfully' });
        } else {
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update photo selection status' });
    }
};

export const validateClientSelection = async (req, res) => {
    try {
        const updated = await validateCollectionSelection(req.collection);
        res.json(updated);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to validate selection' });
    }
};
