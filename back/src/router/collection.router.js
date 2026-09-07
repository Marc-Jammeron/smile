import express from 'express';
import { getAllCollectionsController, getCollectionByIdController, createNewCollectionController, updateExistingCollectionController, softDeleteCollectionByIdController, revokeCollectionAccessController, downloadSelectionHdController, markCollectionAsReadyController } from '../controller/collection.controller.js';

export const collectionRouter = express.Router();

collectionRouter.get('/', getAllCollectionsController);
collectionRouter.get('/:id', getCollectionByIdController);
collectionRouter.post('/', createNewCollectionController);
collectionRouter.put('/:id', updateExistingCollectionController);
collectionRouter.delete('/:id', softDeleteCollectionByIdController);
collectionRouter.post('/:id/revoke-access', revokeCollectionAccessController);
collectionRouter.get('/:id/download-selection-hd', downloadSelectionHdController);
collectionRouter.patch('/:id/mark-ready', markCollectionAsReadyController);