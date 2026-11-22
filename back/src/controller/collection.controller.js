import logger from '../logger.js';
import { getAllCollections, getCollectionById, createCollection, pickCollectionFields, UPDATABLE_COLLECTION_FIELDS, deleteCollection, revokeCollectionAccess, getCollectionProcessingStatus, markCollectionAsReady } from '../services/collection.service.js';

import { requestSelectionHdDownload, toDownloadResponse, getCollectionArchives, retryArchive, isArchiveKind } from '../services/collection-archive.service.js';
import { wakeArchiveWorker } from '../services/archive-worker.service.js';
import { updateCollectionOrDeferSend, cancelSendRequest, SEND_DEFERRED_MESSAGE } from '../services/collection-send.service.js';

const log = logger.child('collection.controller');

export const getAllCollectionsController = async (req, res) => {
    try {
        const collections = await getAllCollections();
        log.debug('Collections listed', { count: collections.length });
        res.json(collections);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch collections' });
    }
};

export const getCollectionByIdController = async (req, res) => {
    const { id } = req.params;
    try {
        const collection = await getCollectionById(id);
        if (collection) {
            log.debug('Collection fetched', { collectionId: id });
            res.json(collection);
        } else {
            log.warn('Collection not found', { collectionId: id });
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch collection' });
    }
};

export const getCollectionProcessingStatusController = async (req, res) => {
    const { id } = req.params;
    try {
        const status = await getCollectionProcessingStatus(id);
        if (status) {
            res.json(status);
        } else {
            log.warn('Collection of the processing status not found', { collectionId: id });
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch the processing status' });
    }
};

export const createNewCollectionController = async (req, res) => {
    try {
        const newCollection = await createCollection(req.body);
        log.info('Collection created', { collectionId: newCollection.id, name: newCollection.name, status: newCollection.status });
        res.status(201).json(newCollection);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to create collection' });
    }
};

export const updateExistingCollectionController = async (req, res) => {
    const { id } = req.params;
    try {
        const changes = pickCollectionFields(req.body, UPDATABLE_COLLECTION_FIELDS);
        if (Object.keys(changes).length === 0) {
            log.warn('Collection update refused: no updatable field in the payload', { collectionId: id, received: Object.keys(req.body ?? {}) });
            return res.status(400).json({ error: 'No updatable field provided' });
        }
        const { collection: updated, deferred } = await updateCollectionOrDeferSend(id, changes);
        if (updated) {
            log.info('Collection updated', { collectionId: id, fields: Object.keys(req.body ?? {}), status: updated.status, sendDeferred: deferred });
            if (deferred) {
                // Photos are still being processed: the link is sent automatically afterwards.
                res.status(202).json({ message: SEND_DEFERRED_MESSAGE, collection: updated });
            } else {
                res.json(updated);
            }
        } else {
            log.warn('Collection to update not found', { collectionId: id });
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update collection' });
    }
};

export const deleteCollectionByIdController = async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await deleteCollection(id);
        if (deleted) {
            log.info('Collection deleted', { collectionId: id });
            res.json({ message: 'Collection deleted successfully' });
        } else {
            log.warn('Collection to delete not found', { collectionId: id });
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete collection' });
    }
};

// The retouching ZIP is built in the background: this answers with a presigned URL once it
// is ready (200), or that it is being prepared (202) or has failed (409). See toDownloadResponse.
export const downloadSelectionHdController = async (req, res) => {
    const { id } = req.params;
    try {
        log.info('Selection HD ZIP requested', { collectionId: id });
        const result = await requestSelectionHdDownload(id);
        const { httpStatus, body } = toDownloadResponse('SELECTION_HD', result);
        log.info('Selection HD ZIP request answered', { collectionId: id, state: result.state, httpStatus });
        res.status(httpStatus).json(body);
    } catch (error) {
        log.failure('Failed to answer the selection HD ZIP request', error, { collectionId: id });
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors de la préparation du ZIP' });
    }
};

export const getCollectionArchivesController = async (req, res) => {
    const { id } = req.params;
    try {
        const archives = await getCollectionArchives(id);
        if (!archives) {
            log.warn('Collection of the archives status not found', { collectionId: id });
            return res.status(404).json({ error: 'Collection not found' });
        }
        res.json(archives);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch the archives status' });
    }
};

export const retryArchiveController = async (req, res) => {
    const { id, kind } = req.params;
    if (!isArchiveKind(kind)) {
        return res.status(400).json({ error: 'Unknown archive kind' });
    }
    try {
        const archive = await retryArchive(id, kind);
        if (!archive) {
            log.warn('Archive retry refused: nothing to retry', { collectionId: id, kind });
            return res.status(409).json({ error: 'No failed archive to retry' });
        }
        wakeArchiveWorker();
        log.info('Archive retry started', { collectionId: id, kind });
        res.json({ kind, status: archive.status });
    } catch (error) {
        log.failure('Failed to retry the archive', error, { collectionId: id, kind });
        res.status(500).json({ error: 'Failed to retry the archive' });
    }
};

export const markCollectionAsReadyController = async (req, res) => {
    const { id } = req.params;
    try {
        log.info('Marking collection as ready', { collectionId: id });
        const updated = await markCollectionAsReady(id);
        log.info('Collection marked as ready', { collectionId: id });
        res.json(updated);
    } catch (error) {
        log.failure('Failed to mark collection as ready', error, { collectionId: id });
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to mark collection as ready' });
    }
};

export const cancelSendRequestController = async (req, res) => {
    const { id } = req.params;
    try {
        const collection = await cancelSendRequest(id);
        if (collection) {
            res.json(collection);
        } else {
            log.warn('Collection of the send request to cancel not found', { collectionId: id });
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        log.failure('Failed to cancel the send request', error, { collectionId: id });
        res.status(500).json({ error: 'Failed to cancel the send request' });
    }
};

export const revokeCollectionAccessController = async (req, res) => {
    const { id } = req.params;
    try {
        const revoked = await revokeCollectionAccess(id);
        if (revoked) {
            log.info('Collection access revoked', { collectionId: id });
            res.json({ message: 'Collection access revoked successfully' });
        } else {
            log.warn('Collection to revoke not found', { collectionId: id });
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to revoke collection access' });
    }
};