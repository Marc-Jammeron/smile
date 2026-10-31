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
        updatedAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    }, {
        createdAt: false
    });
}
