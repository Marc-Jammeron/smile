import { countSelectedPhotos } from "./photo.service.js";
import { updateCollection } from "./collection.service.js";

export const validateCollectionSelection = async (collection) => {
    if (collection.status !== 'SELECTING') {
        const error = new Error('Collection can only be validated while in SELECTING status');
        error.status = 400;
        throw error;
    }

    const selectedCount = await countSelectedPhotos(collection.id);
    if (selectedCount < collection.maxPhotos) {
        const error = new Error(`${selectedCount} photo(s) selected, ${collection.maxPhotos} required`);
        error.status = 400;
        throw error;
    }

    return await updateCollection(collection.id, { status: 'EDITING' });
};
