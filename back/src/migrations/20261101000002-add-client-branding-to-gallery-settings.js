import { DataTypes } from "sequelize";

// Toutes nullables : null = valeur par défaut de la vue client.
const COLUMNS = {
    logoKey: { type: DataTypes.STRING, allowNull: true },
    displayName: { type: DataTypes.STRING(40), allowNull: true },
    tagline: { type: DataTypes.STRING(40), allowNull: true },
    welcomeMessage: { type: DataTypes.STRING(280), allowNull: true },
    // Pas d'enum Postgres : ajouter une police ne doit pas demander de migration.
    fontId: { type: DataTypes.STRING, allowNull: true },
    colorBg: { type: DataTypes.STRING(7), allowNull: true }
};

export const up = async ({ context: queryInterface }) => {
    for (const [name, definition] of Object.entries(COLUMNS)) {
        await queryInterface.addColumn("GallerySettings", name, definition);
    }
};

export const down = async ({ context: queryInterface }) => {
    for (const name of Object.keys(COLUMNS)) {
        await queryInterface.removeColumn("GallerySettings", name);
    }
};
