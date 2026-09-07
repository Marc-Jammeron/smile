import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.createTable("Collections", {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false
        },
        status: {
            type: DataTypes.ENUM('DRAFT', 'SELECTION', 'EDITING', 'READY', 'ARCHIVED'),
            defaultValue: 'DRAFT'
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        viewedByCustomer: {
            type: DataTypes.BOOLEAN,
            defaultValue: false
        },
        maxPhotos: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        createdAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        },
        updatedAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.dropTable("Collections", {});
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Collections_status";');
};
