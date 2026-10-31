import { WATERMARK_POSITIONS } from '../services/settings.constants.js';

// Ligne unique (id = 1). Une colonne nulle signifie « valeur d'origine » (env, puis constante).
export default (sequelize, DataTypes) => {
    return sequelize.define('GallerySettings', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true
        },
        watermarkKey: {
            type: DataTypes.STRING,
            allowNull: true
        },
        watermarkPosition: {
            type: DataTypes.ENUM(...WATERMARK_POSITIONS),
            allowNull: true
        },
        watermarkOpacity: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        watermarkSize: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        logoKey: {
            type: DataTypes.STRING,
            allowNull: true
        },
        displayName: {
            type: DataTypes.STRING(40),
            allowNull: true
        },
        tagline: {
            type: DataTypes.STRING(40),
            allowNull: true
        },
        welcomeMessage: {
            type: DataTypes.STRING(280),
            allowNull: true
        },
        fontId: {
            type: DataTypes.STRING,
            allowNull: true
        },
        colorBg: {
            type: DataTypes.STRING(7),
            allowNull: true
        },
        brandMode: {
            type: DataTypes.STRING,
            allowNull: true
        },
        showTagline: {
            type: DataTypes.BOOLEAN,
            allowNull: true
        },
        updatedAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    }, {
        createdAt: false
    });
}
