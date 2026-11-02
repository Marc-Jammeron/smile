import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.sequelize.query('ALTER TABLE "Collections" DROP COLUMN IF EXISTS "clientEmail";');
    await queryInterface.sequelize.query('ALTER TABLE "Collections" DROP COLUMN IF EXISTS "description";');
};

export const down = async ({ context: queryInterface }) => {
    const columns = await queryInterface.describeTable("Collections");
    if (!columns.clientEmail) {
        await queryInterface.addColumn("Collections", "clientEmail", {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: ""
        });
    }
    if (!columns.description) {
        await queryInterface.addColumn("Collections", "description", {
            type: DataTypes.TEXT,
            allowNull: true
        });
    }
};
