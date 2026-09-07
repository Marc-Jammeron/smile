export const requireAuth = (req, res, next) => {
    if (!req.session?.photographerId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

export const verifyOrigin = (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return next();
    }
    const origin = req.headers.origin;
    if (!origin || origin !== process.env.ADMIN_ORIGIN) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
};
