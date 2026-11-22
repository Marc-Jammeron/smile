import { DataTypes } from "sequelize";

const KIND_ENUM = "enum_CollectionArchives_kind";
const STATUS_ENUM = "enum_CollectionArchives_status";
const QUEUE_INDEX_NAME = "collection_archives_status_created_at";
const UNIQUE_INDEX_NAME = "collection_archives_collection_id_kind";

// Pre-generated ZIPs: one row per (collection, kind), and the table doubles as the work
// queue of the archive worker (same pattern as Photos.processingStatus).
export const up = async ({ context: queryInterface }) => {
    const { sequelize } = queryInterface;

    await sequelize.query(`CREATE TYPE "${KIND_ENUM}" AS ENUM ('SELECTION_HD', 'DELIVERED');`);
    await sequelize.query(`CREATE TYPE "${STATUS_ENUM}" AS ENUM ('QUEUED', 'PROCESSING', 'DONE', 'FAILED');`);

    await queryInterface.createTable("CollectionArchives", {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
            defaultValue: sequelize.literal("gen_random_uuid()")
        },
        collectionId: {
            type: DataTypes.STRING(32),
            allowNull: false,
            references: {
                model: "Collections",
                key: "id"
            },
            onUpdate: "CASCADE",
            onDelete: "CASCADE"
        },
        kind: {
            type: `"${KIND_ENUM}"`,
            allowNull: false
        },
        status: {
            type: `"${STATUS_ENUM}"`,
            allowNull: false,
            defaultValue: "QUEUED"
        },
        // Set once the ZIP is DONE: archives/<collectionId>/<kind>-<short fingerprint>.zip
        s3Key: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        // What the ZIP must contain, and what the stored ZIP actually contains.
        fingerprint: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        builtFingerprint: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        sizeBytes: {
            type: DataTypes.BIGINT,
            allowNull: true
        },
        photoCount: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        attempts: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0
        },
        startedAt: {
            type: DataTypes.DATE,
            allowNull: true
        },
        heartbeatAt: {
            type: DataTypes.DATE,
            allowNull: true
        },
        error: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        },
        updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        }
    });

    await queryInterface.addIndex("CollectionArchives", ["collectionId", "kind"], { name: UNIQUE_INDEX_NAME, unique: true });
    // Queue lookup (oldest QUEUED first) and stuck PROCESSING sweep.
    await queryInterface.addIndex("CollectionArchives", ["status", "createdAt"], { name: QUEUE_INDEX_NAME });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.dropTable("CollectionArchives");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${STATUS_ENUM}";`);
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${KIND_ENUM}";`);
};
