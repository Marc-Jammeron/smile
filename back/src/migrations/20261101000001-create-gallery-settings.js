import { DataTypes } from "sequelize";

const POSITIONS = ["northwest", "northeast", "center", "southwest", "southeast"];

export const up = async ({ context: queryInterface }) => {
    await queryInterface.createTable("GallerySettings", {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true
        },
        watermarkKey: {
            type: DataTypes.STRING,
            allowNull: true
        },
        watermarkPosition: {
            type: DataTypes.ENUM(...POSITIONS),
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
            allowNull: false,
            defaultValue: DataTypes.NOW
        }
    });

    // Une seule ligne de réglages possible.
    await queryInterface.addConstraint("GallerySettings", {
        fields: ["id"],
        type: "check",
        where: { id: 1 },
        name: "GallerySettings_single_row"
    });
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.dropTable("GallerySettings", {});
    // Sans cela, un `up` ultérieur échoue : le type enum survit à la table.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_GallerySettings_watermarkPosition";');
};
