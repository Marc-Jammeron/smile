import { QueryTypes } from "sequelize";

// Makes a confirm replay safe: the same S3 key can only be registered once.
//   Photos(collectionId, key) unique, PhotoAttachments(s3Key) unique.
//
// This migration NEVER deletes anything. If duplicates already exist it stops with a
// readable report. Note that a failing migration makes the server exit at boot (see
// db.repository.js), so run `npm run check-duplicates` against the database BEFORE
// deploying, and `npm run purge-duplicates` (dry-run by default) if it reports any.
// This file is deliberately self-contained: a migration must not change behaviour when a
// shared helper is refactored later (src/scripts/lib/duplicates.js has its own copy).

export const PHOTOS_INDEX = "photos_collection_id_key_unique";
export const ATTACHMENTS_INDEX = "photo_attachments_s3_key_unique";

const DUPLICATE_PHOTOS_SQL = `
    SELECT "collectionId", "key", COUNT(*)::int AS "count",
           array_agg("id" ORDER BY "id") AS "ids",
           array_agg("status"::text ORDER BY "id") AS "statuses"
    FROM "Photos"
    GROUP BY "collectionId", "key"
    HAVING COUNT(*) > 1
    ORDER BY "collectionId", "key"`;

const DUPLICATE_ATTACHMENTS_SQL = `
    SELECT "s3Key", COUNT(*)::int AS "count",
           array_agg("id" ORDER BY "id") AS "ids",
           array_agg("photoId" ORDER BY "id") AS "photoIds"
    FROM "PhotoAttachments"
    GROUP BY "s3Key"
    HAVING COUNT(*) > 1
    ORDER BY "s3Key"`;

const MAX_LISTED = 20;

export const describeDuplicates = ({ photos, attachments }) => {
    const lines = [
        "Cannot add the unique indexes: duplicates already exist. NOTHING was deleted or changed.",
        `Duplicate photos (same collectionId + key): ${photos.length} group(s)`,
        ...photos.slice(0, MAX_LISTED).map((group) =>
            `  - collection ${group.collectionId}, key ${group.key}: ${group.count} rows, ids [${group.ids.join(", ")}], statuses [${group.statuses.join(", ")}]`),
        ...(photos.length > MAX_LISTED ? [`  ... and ${photos.length - MAX_LISTED} more group(s)`] : []),
        `Duplicate attachments (same s3Key): ${attachments.length} group(s)`,
        ...attachments.slice(0, MAX_LISTED).map((group) =>
            `  - s3Key ${group.s3Key}: ${group.count} rows, ids [${group.ids.join(", ")}], photoIds [${group.photoIds.join(", ")}]`),
        ...(attachments.length > MAX_LISTED ? [`  ... and ${attachments.length - MAX_LISTED} more group(s)`] : []),
        "Fix: take a database backup, run `npm run check-duplicates`, then `npm run purge-duplicates` (dry-run) and review its plan before `-- --apply`."
    ];
    return lines.join("\n");
};

export const up = async ({ context: queryInterface }) => {
    const { sequelize } = queryInterface;
    // One transaction: detection and both indexes see the same snapshot, and a failure on the
    // second index cannot leave the first one behind (Postgres DDL is transactional).
    await sequelize.transaction(async (transaction) => {
        const photos = await sequelize.query(DUPLICATE_PHOTOS_SQL, { type: QueryTypes.SELECT, transaction });
        const attachments = await sequelize.query(DUPLICATE_ATTACHMENTS_SQL, { type: QueryTypes.SELECT, transaction });
        if (photos.length > 0 || attachments.length > 0) {
            throw new Error(describeDuplicates({ photos, attachments }));
        }

        await queryInterface.addIndex("Photos", ["collectionId", "key"], { unique: true, name: PHOTOS_INDEX, transaction });
        await queryInterface.addIndex("PhotoAttachments", ["s3Key"], { unique: true, name: ATTACHMENTS_INDEX, transaction });
    });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeIndex("PhotoAttachments", ATTACHMENTS_INDEX);
    await queryInterface.removeIndex("Photos", PHOTOS_INDEX);
};
