export default (sequelize, DataTypes) => {
    return sequelize.define('Photo', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        collectionId: {
            type: DataTypes.STRING(32),
            allowNull: false
        },
        key: {
            type: DataTypes.STRING,
            allowNull: false
        },
        thumbnailKey: {
            type: DataTypes.STRING,
            allowNull: true
        },
        previewKey: {
            type: DataTypes.STRING,
            allowNull: true
        },
        originalFilename: {
            type: DataTypes.STRING,
            allowNull: true
        },
        contentType: {
            type: DataTypes.STRING,
            allowNull: true
        },
        size: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        status: {
            type: DataTypes.ENUM('PENDING', 'SELECTED', 'REJECTED', 'ARCHIVED', 'DELIVERED'),
            defaultValue: 'PENDING'
        },
        createdAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        },
        updatedAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    });
}
