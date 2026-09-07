import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.addColumn("Collections", "accessToken", {
        type: DataTypes.STRING(64),
        unique: true,
        allowNull: true
    });
    await queryInterface.addColumn("Collections", "accessTokenExpiresAt", {
        type: DataTypes.DATE,
        allowNull: true
    });
    await queryInterface.addColumn("Collections", "accessTokenRevokedAt", {
        type: DataTypes.DATE,
        allowNull: true
    });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeColumn("Collections", "accessToken");
    await queryInterface.removeColumn("Collections", "accessTokenExpiresAt");
    await queryInterface.removeColumn("Collections", "accessTokenRevokedAt");
};
