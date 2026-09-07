import express from 'express';
import { getPhotosByCollectionId, getPhoto, createNewPhotosBatch, confirmNewPhotosBatch, updateExistingPhoto, updatePhotoSelection, softDeletePhotoById, deleteDeliveredPhotoById } from '../controller/photo.controller.js';

export const photoRouter = express.Router();

photoRouter.get('/collection/:collectionId', getPhotosByCollectionId);
photoRouter.get('/:id', getPhoto);
photoRouter.post('/batch', createNewPhotosBatch);
photoRouter.post('/confirm/batch', confirmNewPhotosBatch);
photoRouter.put('/:id', updateExistingPhoto);
photoRouter.patch('/:id/selection', updatePhotoSelection);
photoRouter.delete('/delivered/:id', deleteDeliveredPhotoById);
photoRouter.delete('/:id', softDeletePhotoById);