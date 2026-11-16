import { DataTypes } from "sequelize";

const ENUM_NAME = "enum_Photos_processingStatus";
const QUEUE_INDEX_NAME = "photos_processing_status_created_at";
const COLLECTION_INDEX_NAME = "photos_collection_id_processing_status";

// Asynchronous derived-image generation: the Photo table doubles as the work queue.
// Rows that already exist were processed inline, so they are migrated as DONE; only
// rows created from now on start as QUEUED (default switched right after the backfill).
export const up = async ({ context: queryInterface }) => {
    const { sequelize } = queryInterface;

    await sequelize.query(`CREATE TYPE "${ENUM_NAME}" AS ENUM ('QUEUED', 'PROCESSING', 'DONE', 'FAILED');`);
    await sequelize.query(`ALTER TABLE "Photos" ADD COLUMN "processingStatus" "${ENUM_NAME}" NOT NULL DEFAULT 'DONE';`);
    await sequelize.query(`ALTER TABLE "Photos" ALTER COLUMN "processingStatus" SET DEFAULT 'QUEUED';`);

    await queryInterface.addColumn("Photos", "processingAttempts", {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    });
    await queryInterface.addColumn("Photos", "processingStartedAt", {
        type: DataTypes.DATE,
        allowNull: true
    });
    await queryInterface.addColumn("Photos", "processingError", {
        type: DataTypes.TEXT,
        allowNull: true
    });

    // thumbnailKey and previewKey stay empty until the photo is DONE.
    await queryInterface.changeColumn("Photos", "thumbnailKey", { type: DataTypes.STRING, allowNull: true });
    await queryInterface.changeColumn("Photos", "previewKey", { type: DataTypes.STRING, allowNull: true });

    await queryInterface.addColumn("Collections", "sendRequestedAt", {
        type: DataTypes.DATE,
        allowNull: true
    });

    // Queue lookup (oldest QUEUED first, stuck PROCESSING sweep) and per-collection counters.
    await queryInterface.addIndex("Photos", ["processingStatus", "createdAt"], { name: QUEUE_INDEX_NAME });
    await queryInterface.addIndex("Photos", ["collectionId", "processingStatus"], { name: COLLECTION_INDEX_NAME });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeIndex("Photos", COLLECTION_INDEX_NAME);
    await queryInterface.removeIndex("Photos", QUEUE_INDEX_NAME);
    await queryInterface.removeColumn("Collections", "sendRequestedAt");
    await queryInterface.removeColumn("Photos", "processingError");
    await queryInterface.removeColumn("Photos", "processingStartedAt");
    await queryInterface.removeColumn("Photos", "processingAttempts");
    await queryInterface.removeColumn("Photos", "processingStatus");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${ENUM_NAME}";`);
};
