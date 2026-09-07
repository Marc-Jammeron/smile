export default (sequelize, DataTypes) => {
    return sequelize.define('PhotoAttachment', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        photoId: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        originalFilename: {
            type: DataTypes.STRING,
            allowNull: false
        },
        s3Key: {
            type: DataTypes.STRING,
            allowNull: false
        },
        fileSize: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        mimeType: {
            type: DataTypes.STRING,
            allowNull: true
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
