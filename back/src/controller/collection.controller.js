import { getAllCollections, getCollectionById, createCollection, updateCollection, softDeleteCollection, revokeCollectionAccess, streamSelectionHdZip, markCollectionAsReady } from '../services/collection.service.js';

export const getAllCollectionsController = async (req, res) => {
    try {
        const collections = await getAllCollections();
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
            res.json(collection);
        } else {
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch collection' });
    }
};

export const createNewCollectionController = async (req, res) => {
    try {
        const newCollection = await createCollection(req.body);
        res.status(201).json(newCollection);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create collection' });
    }
};

export const updateExistingCollectionController = async (req, res) => {
    const { id } = req.params;
    try {
        const updated = await updateCollection(id, req.body);
        if (updated) {
            res.json(updated);
        } else {
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to update collection' });
    }
};

export const softDeleteCollectionByIdController = async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await softDeleteCollection(id);
        if (deleted) {
            res.json({ message: 'Collection soft deleted successfully' });
        } else {
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to soft delete collection' });
    }
};

export const downloadSelectionHdController = async (req, res) => {
    const { id } = req.params;
    try {
        await streamSelectionHdZip(id, res);
    } catch (error) {
        if (res.headersSent) {
            console.error(`Error generating selection HD zip for collection ${id}:`, error.message);
            return;
        }
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors de la génération du ZIP' });
    }
};

export const markCollectionAsReadyController = async (req, res) => {
    const { id } = req.params;
    try {
        const updated = await markCollectionAsReady(id);
        res.json(updated);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to mark collection as ready' });
    }
};

export const revokeCollectionAccessController = async (req, res) => {
    const { id } = req.params;
    try {
        const revoked = await revokeCollectionAccess(id);
        if (revoked) {
            res.json({ message: 'Collection access revoked successfully' });
        } else {
            res.status(404).json({ error: 'Collection not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to revoke collection access' });
    }
};