import { countSelectedPhotos } from "./photo.service.js";
import { updateCollection } from "./collection.service.js";
import logger from "../logger.js";

const log = logger.child("client.service");

export const validateCollectionSelection = async (collection) => {
    if (collection.status !== 'SELECTING') {
        log.warn('Selection validation refused: collection is not in SELECTING status', { collectionId: collection.id, status: collection.status });
        const error = new Error('Collection can only be validated while in SELECTING status');
        error.status = 400;
        throw error;
    }

    const selectedCount = await countSelectedPhotos(collection.id);
    if (selectedCount < collection.maxPhotos) {
        log.warn('Selection validation refused: not enough photos selected', { collectionId: collection.id, selectedCount, required: collection.maxPhotos });
        const error = new Error(`${selectedCount} photo(s) selected, ${collection.maxPhotos} required`);
        error.status = 400;
        throw error;
    }

    log.debug('Selection is complete, moving the collection to EDITING', { collectionId: collection.id, selectedCount });
    return await updateCollection(collection.id, { status: 'EDITING' });
};
