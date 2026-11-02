import { DataTypes, QueryTypes } from "sequelize";

const INDEX_NAME = "photos_collection_id_position";

const UUID_PREFIX_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

const getSortName = (photo) =>
    photo.originalFilename || photo.key.split("/").pop().replace(UUID_PREFIX_PATTERN, "");

const compareNatural = (a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export const up = async ({ context: queryInterface }) => {
    await queryInterface.addColumn("Photos", "position", {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    });

    // Existing photos have no upload order to recover (ids follow sharp's completion
    // order): rank them per collection by natural filename, id as tie-breaker.
    const photos = await queryInterface.sequelize.query(
        'SELECT "id", "collectionId", "originalFilename", "key" FROM "Photos"',
        { type: QueryTypes.SELECT }
    );

    const photosByCollection = new Map();
    for (const photo of photos) {
        if (!photosByCollection.has(photo.collectionId)) {
            photosByCollection.set(photo.collectionId, []);
        }
        photosByCollection.get(photo.collectionId).push(photo);
    }

    await queryInterface.sequelize.transaction(async (transaction) => {
        for (const collectionPhotos of photosByCollection.values()) {
            collectionPhotos.sort((a, b) => compareNatural(getSortName(a), getSortName(b)) || a.id - b.id);
            for (const [position, photo] of collectionPhotos.entries()) {
                await queryInterface.sequelize.query(
                    'UPDATE "Photos" SET "position" = :position WHERE "id" = :id',
                    { replacements: { position, id: photo.id }, transaction }
                );
            }
        }
    });

    await queryInterface.addIndex("Photos", ["collectionId", "position"], { name: INDEX_NAME });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeIndex("Photos", INDEX_NAME);
    await queryInterface.removeColumn("Photos", "position");
};
