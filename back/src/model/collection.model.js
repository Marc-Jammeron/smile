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
        clientName: {
            type: DataTypes.STRING,
            allowNull: false
        },
        clientMessage: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        finalMessage: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        status: {
            type: DataTypes.ENUM('DRAFT', 'SELECTING', 'EDITING', 'READY', 'ARCHIVED'),
            defaultValue: 'DRAFT'
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
        },
        // Set when the photographer asks for the client link while photos are still being
        // processed; the worker performs the DRAFT -> SELECTING transition once all are DONE.
        sendRequestedAt: {
            type: DataTypes.DATE,
            allowNull: true
        }
    });
}
