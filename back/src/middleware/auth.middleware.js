import logger from '../logger.js';

const log = logger.child('auth');

export const requireAuth = (req, res, next) => {
    if (!req.session?.photographerId) {
        log.warn('Unauthenticated request to a protected route', { method: req.method, baseUrl: req.baseUrl, ip: req.ip });
        return res.status(401).json({ error: 'Unauthorized' });
    }
    log.debug('Session authenticated');
    next();
};

export const verifyOrigin = (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return next();
    }
    const origin = req.headers.origin;
    if (!origin || origin !== process.env.ADMIN_ORIGIN) {
        log.warn('Request rejected: origin not allowed for a state-changing method', {
            method: req.method,
            baseUrl: req.baseUrl,
            origin: origin ?? null,
            expectedOrigin: process.env.ADMIN_ORIGIN ?? null,
            ip: req.ip
        });
        return res.status(403).json({ error: 'Forbidden' });
    }
    log.debug('Origin verified', { origin });
    next();
};
