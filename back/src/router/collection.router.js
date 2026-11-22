import express from 'express';
import { getAllCollectionsController, getCollectionByIdController, createNewCollectionController, updateExistingCollectionController, deleteCollectionByIdController, revokeCollectionAccessController, downloadSelectionHdController, markCollectionAsReadyController, cancelSendRequestController, getCollectionProcessingStatusController, getCollectionArchivesController, retryArchiveController } from '../controller/collection.controller.js';

export const collectionRouter = express.Router();

collectionRouter.get('/', getAllCollectionsController);
collectionRouter.get('/:id', getCollectionByIdController);
collectionRouter.get('/:id/processing-status', getCollectionProcessingStatusController);
collectionRouter.post('/', createNewCollectionController);
collectionRouter.put('/:id', updateExistingCollectionController);
collectionRouter.delete('/:id', deleteCollectionByIdController);
collectionRouter.post('/:id/revoke-access', revokeCollectionAccessController);
collectionRouter.get('/:id/download-selection-hd', downloadSelectionHdController);
collectionRouter.get('/:id/archives', getCollectionArchivesController);
collectionRouter.post('/:id/archives/:kind/retry', retryArchiveController);
collectionRouter.patch('/:id/mark-ready', markCollectionAsReadyController);
collectionRouter.delete('/:id/send-request', cancelSendRequestController);
