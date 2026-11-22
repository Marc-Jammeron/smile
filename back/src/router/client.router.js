import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { loadGalleryByToken } from '../middleware/client.middleware.js';
import logger from '../logger.js';
import { getClientGallery, updateClientPhotoSelection, validateClientSelection, downloadAllDeliveredPhotos, getClientArchive } from '../controller/client.controller.js';

const log = logger.child('client.router');

export const clientRouter = express.Router();

const WINDOW_MS = 15 * 60 * 1000;

const onLimitReached = (req, res, next, options) => {
    log.warn('Client rate limit exceeded', { ip: req.ip, limit: options.limit, windowMs: options.windowMs });
    res.status(options.statusCode).send(options.message);
};

// The page of a READY collection asks for the state of its ZIP every 5 seconds while it is
// being prepared (up to a few minutes): that polling would eat the general budget in a
// quarter of an hour, so it has its own, larger one. The route only reads a status.
const isArchiveStatusRequest = (req) => req.method === 'GET' && /^\/[^/]+\/archive$/.test(req.path);

const clientRateLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isArchiveStatusRequest,
    handler: onLimitReached
});

const archiveStatusRateLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: 400,
    standardHeaders: true,
    legacyHeaders: false,
    handler: onLimitReached
});

clientRouter.use(clientRateLimiter);

clientRouter.get('/:token', loadGalleryByToken, getClientGallery);
clientRouter.patch('/:token/photos/:photoId/selection', loadGalleryByToken, updateClientPhotoSelection);
clientRouter.post('/:token/validate', loadGalleryByToken, validateClientSelection);
clientRouter.get('/:token/download-all', loadGalleryByToken, downloadAllDeliveredPhotos);
clientRouter.get('/:token/archive', archiveStatusRateLimiter, loadGalleryByToken, getClientArchive);
