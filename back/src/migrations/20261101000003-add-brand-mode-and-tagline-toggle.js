import { DataTypes } from "sequelize";

// null = comportement par défaut : brandMode « logo si présent, sinon nom », sous-titre affiché.
const COLUMNS = {
    // Pas d'enum Postgres, comme fontId.
    brandMode: { type: DataTypes.STRING, allowNull: true },
    showTagline: { type: DataTypes.BOOLEAN, allowNull: true }
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
