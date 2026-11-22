export const ARCHIVE_KINDS = ['SELECTION_HD', 'DELIVERED'];
export const ARCHIVE_STATUSES = ['QUEUED', 'PROCESSING', 'DONE', 'FAILED'];

export default (sequelize, DataTypes) => {
    return sequelize.define('CollectionArchive', {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
            defaultValue: DataTypes.UUIDV4
        },
        collectionId: {
            type: DataTypes.STRING(32),
            allowNull: false
        },
        kind: {
            type: DataTypes.ENUM(...ARCHIVE_KINDS),
            allowNull: false
        },
        status: {
            type: DataTypes.ENUM(...ARCHIVE_STATUSES),
            allowNull: false,
            defaultValue: 'QUEUED'
        },
        s3Key: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        fingerprint: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        builtFingerprint: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        // BIGINT comes back from pg as a string: callers convert it with Number().
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
        }
    }, {
        indexes: [{ unique: true, fields: ['collectionId', 'kind'] }]
    });
}
