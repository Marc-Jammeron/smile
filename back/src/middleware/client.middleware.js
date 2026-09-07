import db from "../repository/db.repository.js";

export const loadGalleryByToken = async (req, res, next) => {
    const { token } = req.params;
    try {
        const collection = await db.Collection.findOne({ where: { accessToken: token } });

        if (!collection
            || collection.status === 'ARCHIVED'
            || collection.accessTokenRevokedAt
            || (collection.accessTokenExpiresAt && collection.accessTokenExpiresAt < new Date())) {
            return res.status(404).json({ error: 'Not found' });
        }

        req.collection = collection;
        next();
    } catch (error) {
        console.error('Error loading gallery by token:', error);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
};
