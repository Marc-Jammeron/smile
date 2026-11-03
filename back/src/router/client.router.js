import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { loadGalleryByToken } from '../middleware/client.middleware.js';
import logger from '../logger.js';
import { getClientGallery, updateClientPhotoSelection, validateClientSelection, downloadAllDeliveredPhotos } from '../controller/client.controller.js';

const log = logger.child('client.router');

export const clientRouter = express.Router();

const clientRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        log.warn('Client rate limit exceeded', { ip: req.ip, limit: options.limit, windowMs: options.windowMs });
        res.status(options.statusCode).send(options.message);
    }
});

clientRouter.use(clientRateLimiter);

clientRouter.get('/:token', loadGalleryByToken, getClientGallery);
clientRouter.patch('/:token/photos/:photoId/selection', loadGalleryByToken, updateClientPhotoSelection);
clientRouter.post('/:token/validate', loadGalleryByToken, validateClientSelection);
clientRouter.get('/:token/download-all', loadGalleryByToken, downloadAllDeliveredPhotos);
