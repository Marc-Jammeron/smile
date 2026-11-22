import { getAllClientPhotosByCollectionId, getDeliveredPhotosByCollectionId, updatePhotoSelectionStatus } from '../services/photo.service.js';
import { markCollectionAsViewed } from '../services/collection.service.js';
import { requestDeliveredDownload, toDownloadResponse, getClientArchiveInfo } from '../services/collection-archive.service.js';
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
        // The state of the "download all" button, without an extra request from the client.
        let archive = null;
        if (status === 'READY') {
            try {
                archive = await getClientArchiveInfo(collectionId);
            } catch (error) {
                log.error('Failed to read the archive status, serving the gallery without it', error, { collectionId });
            }
        }
        log.debug('Client gallery served', { collectionId, status, photoCount: photos.length, hasBranding: branding !== null, archiveStatus: archive?.status ?? null });
        res.json({ collection: req.collection, photos, photographerName: process.env.PHOTOGRAPHER_DISPLAY_NAME || null, branding, ...(status === 'READY' && { archive }) });
    } catch (error) {
        log.error('Failed to fetch client gallery', error, { collectionId });
        res.status(500).json({ error: 'Failed to fetch gallery' });
    }
};

// The delivered ZIP is built in the background: 200 { url } once it is ready (the client then
// navigates to it), 202 while it is being prepared, 409 when it failed. The token is the only
// credential: the URL is never part of the gallery payload, it is returned on request.
export const downloadAllDeliveredPhotos = async (req, res) => {
    const collectionId = req.collection.id;
    try {
        log.info('Client requested the delivered photos ZIP', { collectionId });
        const result = await requestDeliveredDownload(req.collection);
        const { httpStatus, body } = toDownloadResponse('DELIVERED', result);
        log.info('Delivered photos ZIP request answered', { collectionId, state: result.state, httpStatus });
        res.status(httpStatus).json(body);
    } catch (error) {
        log.failure('Failed to answer the delivered photos ZIP request', error, { collectionId });
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors de la préparation du ZIP' });
    }
};

// Light read for the polling of the "download all" button (the gallery itself is too heavy to
// reload every few seconds). Same answer as download-all outside READY: nothing is there.
export const getClientArchive = async (req, res) => {
    const collectionId = req.collection.id;
    if (req.collection.status !== 'READY') {
        return res.status(404).json({ error: 'Not found' });
    }
    try {
        res.json({ archive: await getClientArchiveInfo(collectionId) });
    } catch (error) {
        log.error('Failed to read the archive status', error, { collectionId });
        res.status(500).json({ error: 'Failed to read the archive status' });
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
