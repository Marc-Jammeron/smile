import { getAllClientPhotosByCollectionId, getDeliveredPhotosByCollectionId, updatePhotoSelectionStatus } from '../services/photo.service.js';
import { markCollectionAsViewed, streamDeliveredZip } from '../services/collection.service.js';
import { validateCollectionSelection } from '../services/client.service.js';
import { getClientBranding } from '../services/settings.service.js';
import logger from '../logger.js';

const log = logger.child('client.controller');

export const getClientGallery = async (req, res) => {
    const { id: collectionId, status } = req.collection;
    try {
        if (!req.collection.viewedByCustomer) {
            log.info('Client opened the gallery for the first time', { collectionId });
            await markCollectionAsViewed(collectionId);
        }
        const photos = status === 'READY'
            ? await getDeliveredPhotosByCollectionId(collectionId)
            : await getAllClientPhotosByCollectionId(collectionId);
        let branding = null;
        try {
            branding = await getClientBranding();
        } catch (error) {
            log.error('Failed to load client branding, serving the gallery without it', error, { collectionId });
        }
        log.debug('Client gallery served', { collectionId, status, photoCount: photos.length, hasBranding: branding !== null });
        res.json({ collection: req.collection, photos, photographerName: process.env.PHOTOGRAPHER_DISPLAY_NAME || null, branding });
    } catch (error) {
        log.error('Failed to fetch client gallery', error, { collectionId });
        res.status(500).json({ error: 'Failed to fetch gallery' });
    }
};

export const downloadAllDeliveredPhotos = async (req, res) => {
    const collectionId = req.collection.id;
    try {
        log.info('Client requested the delivered photos ZIP', { collectionId });
        await streamDeliveredZip(req.collection, res);
        log.info('Delivered photos ZIP sent', { collectionId });
    } catch (error) {
        if (res.headersSent) {
            log.error('Delivered ZIP failed after streaming started', error, { collectionId });
            return;
        }
        log.failure('Failed to generate the delivered photos ZIP', error, { collectionId });
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors de la génération du ZIP' });
    }
};

export const updateClientPhotoSelection = async (req, res) => {
    const { photoId } = req.params;
    const { status } = req.body;
    const collectionId = req.collection?.id;
    try {
        const updated = await updatePhotoSelectionStatus(photoId, status);
        if (updated) {
            log.info('Client changed a photo selection', { collectionId, photoId, status });
            res.json({ message: 'Photo selection status updated successfully' });
        } else {
            log.warn('Client selection targets an unknown photo', { collectionId, photoId });
            res.status(404).json({ error: 'Photo not found' });
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update photo selection status' });
    }
};

export const validateClientSelection = async (req, res) => {
    const collectionId = req.collection.id;
    try {
        log.info('Client is validating the selection', { collectionId });
        const updated = await validateCollectionSelection(req.collection);
        log.info('Client selection validated', { collectionId, newStatus: updated?.status });
        res.json(updated);
    } catch (error) {
        log.failure('Client selection validation failed', error, { collectionId });
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to validate selection' });
    }
};
