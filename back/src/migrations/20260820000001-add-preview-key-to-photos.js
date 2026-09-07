import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.addColumn("Photos", "previewKey", {
        type: DataTypes.STRING,
        allowNull: true
    });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeColumn("Photos", "previewKey");
};
