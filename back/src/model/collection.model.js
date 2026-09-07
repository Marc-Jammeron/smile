import crypto from 'crypto';

export default (sequelize, DataTypes) => {
    return sequelize.define('Collection', {
        id: {
            type: DataTypes.STRING(32),
            primaryKey: true,
            defaultValue: () => crypto.randomBytes(16).toString('hex')
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false
        },
        clientEmail: {
            type: DataTypes.STRING,
            allowNull: false
        },
        clientName: {
            type: DataTypes.STRING,
            allowNull: false
        },
        status: {
            type: DataTypes.ENUM('DRAFT', 'SELECTING', 'EDITING', 'READY', 'ARCHIVED'),
            defaultValue: 'DRAFT'
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        createdAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        },
        updatedAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        },
        viewedByCustomer: {
            type: DataTypes.BOOLEAN,
            defaultValue: false
        },
        maxPhotos: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        accessToken: {
            type: DataTypes.STRING(64),
            unique: true,
            allowNull: true
        },
        accessTokenExpiresAt: {
            type: DataTypes.DATE,
            allowNull: true
        },
        accessTokenRevokedAt: {
            type: DataTypes.DATE,
            allowNull: true
        }
    });
}
