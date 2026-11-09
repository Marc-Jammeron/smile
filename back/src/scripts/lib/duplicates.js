import { QueryTypes } from "sequelize";

// Shared by `check-duplicates` (read-only) and `purge-duplicates` (dry-run unless --apply).
// DATABASE ONLY: these helpers never touch S3. Duplicate Photo rows share the same derived
// thumbnail/preview objects (their keys are derived from `key`), so deleting S3 objects for
// a duplicate would destroy the files of the row that is kept.

export const DUPLICATE_PHOTOS_SQL = `
    SELECT "collectionId", "key", COUNT(*)::int AS "count",
           array_agg("id" ORDER BY "id") AS "ids",
           array_agg("status"::text ORDER BY "id") AS "statuses"
    FROM "Photos"
    GROUP BY "collectionId", "key"
    HAVING COUNT(*) > 1
    ORDER BY "collectionId", "key"`;

export const DUPLICATE_ATTACHMENTS_SQL = `
    SELECT "s3Key", COUNT(*)::int AS "count",
           array_agg("id" ORDER BY "id") AS "ids",
           array_agg("photoId" ORDER BY "id") AS "photoIds"
    FROM "PhotoAttachments"
    GROUP BY "s3Key"
    HAVING COUNT(*) > 1
    ORDER BY "s3Key"`;

// Same file uploaded again under a NEW key (new uuid): not covered by the unique indexes,
// informational only.
export const SAME_FILENAME_SQL = `
    SELECT "collectionId", "originalFilename", "size", COUNT(*)::int AS "count",
           array_agg("id" ORDER BY "id") AS "ids"
    FROM "Photos"
    WHERE "originalFilename" IS NOT NULL AND "status" <> 'ARCHIVED'
    GROUP BY "collectionId", "originalFilename", "size"
    HAVING COUNT(*) > 1
    ORDER BY "collectionId", "originalFilename"`;

export const findDuplicatePhotos = (sequelize, options = {}) =>
    sequelize.query(DUPLICATE_PHOTOS_SQL, { type: QueryTypes.SELECT, ...options });

export const findDuplicateAttachments = (sequelize, options = {}) =>
    sequelize.query(DUPLICATE_ATTACHMENTS_SQL, { type: QueryTypes.SELECT, ...options });

export const findSameFilenameUploads = (sequelize, options = {}) =>
    sequelize.query(SAME_FILENAME_SQL, { type: QueryTypes.SELECT, ...options });

// A row that carries a client decision or a delivery is worth more than a pristine one.
const STATUS_RANK = { DELIVERED: 4, SELECTED: 3, REJECTED: 3, PENDING: 2, ARCHIVED: 1 };

// Keeps, per (collectionId, key), the row with the most advanced status, the lowest id on
// ties. When the best rows disagree (e.g. SELECTED vs REJECTED: two different client
// decisions) nothing is decided: the group is flagged for a human.
export const planPhotoPurge = (groups) => groups.map(({ collectionId, key, ids, statuses }) => {
    const rows = ids.map((id, index) => ({ id, status: statuses[index], rank: STATUS_RANK[statuses[index]] ?? 0 }));
    const bestRank = Math.max(...rows.map((row) => row.rank));
    const best = rows.filter((row) => row.rank === bestRank);
    if (new Set(best.map((row) => row.status)).size > 1) {
        return { collectionId, key, action: "review", ids, statuses, reason: `conflicting statuses [${[...new Set(best.map((row) => row.status))].join(", ")}]` };
    }
    const keep = best[0]; // ids are ordered ascending: lowest id among the best
    return {
        collectionId, key, action: "dedupe", keep: keep.id, keepStatus: keep.status,
        remove: rows.filter((row) => row.id !== keep.id).map((row) => row.id)
    };
});

const formatList = (values) => `[${values.join(", ")}]`;

export const formatPlan = ({ photoPlan, attachmentGroups, sameFilename }) => {
    const lines = [];
    lines.push(`Duplicate photos: ${photoPlan.length} group(s)`);
    for (const entry of photoPlan) {
        if (entry.action === "review") {
            lines.push(`  ! REVIEW (will not be touched) collection ${entry.collectionId} key ${entry.key}: ids ${formatList(entry.ids)} ${entry.reason}`);
        } else {
            lines.push(`  - collection ${entry.collectionId} key ${entry.key}: KEEP id ${entry.keep} (${entry.keepStatus}), DELETE rows ${formatList(entry.remove)} (database only; their attachments are moved to the kept row first)`);
        }
    }
    lines.push(`Duplicate attachments (same s3Key): ${attachmentGroups.length} group(s) - the row with the lowest id is kept, the others are deleted (database only)`);
    for (const group of attachmentGroups.slice(0, 50)) {
        lines.push(`  - s3Key ${group.s3Key}: ids ${formatList(group.ids)} on photos ${formatList(group.photoIds)}`);
    }
    if (sameFilename) {
        lines.push(`Info only (not touched, not covered by the unique indexes): ${sameFilename.length} group(s) of photos with the same collection + filename + size but different keys`);
    }
    return lines.join("\n");
};

// Runs the purge in ONE transaction. Order matters: attachments are moved to the kept row
// before the losers are deleted (ON DELETE CASCADE would otherwise drop them), then the
// duplicate attachments are removed, then the loser photos. Anything unexpected throws and
// rolls everything back.
export const applyPurge = async (sequelize, photoPlan) => {
    const toDedupe = photoPlan.filter((entry) => entry.action === "dedupe");
    return sequelize.transaction(async (transaction) => {
        const report = { movedAttachments: 0, deletedAttachments: 0, deletedPhotos: 0 };

        for (const entry of toDedupe) {
            const moved = await sequelize.query(
                'UPDATE "PhotoAttachments" SET "photoId" = :keep WHERE "photoId" IN (:remove) RETURNING "id"',
                { replacements: { keep: entry.keep, remove: entry.remove }, type: QueryTypes.SELECT, transaction }
            );
            report.movedAttachments += moved.length;
        }

        const removedAttachments = await sequelize.query(
            'DELETE FROM "PhotoAttachments" a USING "PhotoAttachments" b WHERE a."s3Key" = b."s3Key" AND a."id" > b."id" RETURNING a."id"',
            { type: QueryTypes.SELECT, transaction }
        );
        report.deletedAttachments = removedAttachments.length;

        for (const entry of toDedupe) {
            const deleted = await sequelize.query(
                'DELETE FROM "Photos" WHERE "id" IN (:remove) AND "collectionId" = :collectionId AND "key" = :key RETURNING "id"',
                { replacements: { remove: entry.remove, collectionId: entry.collectionId, key: entry.key }, type: QueryTypes.SELECT, transaction }
            );
            if (deleted.length !== entry.remove.length) {
                throw new Error(`Expected to delete ${entry.remove.length} row(s) for key ${entry.key}, deleted ${deleted.length}: rolling back`);
            }
            report.deletedPhotos += deleted.length;
        }

        const stillDuplicated = await findDuplicateAttachments(sequelize, { transaction });
        if (stillDuplicated.length > 0) {
            throw new Error(`${stillDuplicated.length} duplicate attachment group(s) remain after the purge: rolling back`);
        }
        return report;
    });
};

export const parsePurgeArgs = (argv) => ({ apply: argv.includes("--apply") });
