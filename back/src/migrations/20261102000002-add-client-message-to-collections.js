import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.addColumn("Collections", "clientMessage", {
        type: DataTypes.TEXT,
        allowNull: true
    });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeColumn("Collections", "clientMessage");
};
