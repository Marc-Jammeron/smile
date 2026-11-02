import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.addColumn("GallerySettings", "watermarkText", {
        type: DataTypes.STRING(130),
        allowNull: true
    });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeColumn("GallerySettings", "watermarkText");
};
