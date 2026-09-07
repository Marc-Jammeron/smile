import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.createTable("Photos", {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        collectionId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: "Collections",
                key: "id"
            },
            onUpdate: "CASCADE",
            onDelete: "CASCADE"
        },
        key: {
            type: DataTypes.STRING,
            allowNull: false
        },
        thumbnailKey: {
            type: DataTypes.STRING,
            allowNull: true
        },
        contentType: {
            type: DataTypes.STRING,
            allowNull: true
        },
        size: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        status: {
            type: DataTypes.ENUM('PENDING', 'SELECTED', 'REJECTED'),
            defaultValue: 'PENDING'
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
    await queryInterface.dropTable("Photos", {});
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Photos_status";');
};
