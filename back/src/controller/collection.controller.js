import logger from '../logger.js';
import { getAllCollections, getCollectionById, createCollection, updateCollection, pickCollectionFields, UPDATABLE_COLLECTION_FIELDS, deleteCollection, revokeCollectionAccess, streamSelectionHdZip, markCollectionAsReady } from '../services/collection.service.js';

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
        const updated = await updateCollection(id, changes);
        if (updated) {
            log.info('Collection updated', { collectionId: id, fields: Object.keys(req.body ?? {}), status: updated.status });
            res.json(updated);
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

export const downloadSelectionHdController = async (req, res) => {
    const { id } = req.params;
    try {
        log.info('Selection HD ZIP requested', { collectionId: id });
        await streamSelectionHdZip(id, res);
        log.info('Selection HD ZIP sent', { collectionId: id });
    } catch (error) {
        if (res.headersSent) {
            log.error('Selection HD ZIP failed after streaming started', error, { collectionId: id });
            return;
        }
        log.failure('Failed to generate the selection HD ZIP', error, { collectionId: id });
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors de la génération du ZIP' });
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