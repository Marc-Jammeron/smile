import db from "../repository/db.repository.js";
import logger from "../logger.js";

const log = logger.child('client.middleware');

// Le jeton d'accès est un secret (il donne accès à la galerie) : il n'est jamais loggué,
// seuls l'id de collection et la raison du refus le sont.
const rejectionReason = (collection) => {
    if (!collection) return 'unknown token';
    if (collection.status === 'ARCHIVED') return 'collection archived';
    if (collection.accessTokenRevokedAt) return 'access revoked';
    if (collection.accessTokenExpiresAt && collection.accessTokenExpiresAt < new Date()) return 'access expired';
    return null;
};

export const loadGalleryByToken = async (req, res, next) => {
    const { token } = req.params;
    try {
        const collection = await db.Collection.findOne({ where: { accessToken: token } });

        const reason = rejectionReason(collection);
        if (reason) {
            log.warn('Client gallery access refused', { reason, collectionId: collection?.id, ip: req.ip });
            return res.status(404).json({ error: 'Not found' });
        }

        log.debug('Client gallery access granted', { collectionId: collection.id, status: collection.status });
        req.collection = collection;
        next();
    } catch (error) {
        log.error('Error loading gallery by token', error);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
};
