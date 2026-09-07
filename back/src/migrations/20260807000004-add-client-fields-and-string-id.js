import { DataTypes } from "sequelize";

export const up = async ({ context: queryInterface }) => {
    await queryInterface.sequelize.query('ALTER TABLE "Photos" DROP CONSTRAINT "Photos_collectionId_fkey";');

    await queryInterface.sequelize.query('ALTER TABLE "Collections" ALTER COLUMN "id" DROP DEFAULT;');
    await queryInterface.sequelize.query('ALTER TABLE "Collections" ALTER COLUMN "id" TYPE VARCHAR(32) USING "id"::text;');
    await queryInterface.sequelize.query('ALTER TABLE "Photos" ALTER COLUMN "collectionId" TYPE VARCHAR(32) USING "collectionId"::text;');

    await queryInterface.addConstraint("Photos", {
        fields: ["collectionId"],
        type: "foreign key",
        name: "Photos_collectionId_fkey",
        references: { table: "Collections", field: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE"
    });

    await queryInterface.addColumn("Collections", "clientEmail", {
        type: DataTypes.STRING,
        allowNull: false
    });
    await queryInterface.addColumn("Collections", "clientName", {
        type: DataTypes.STRING,
        allowNull: false
    });

    await queryInterface.sequelize.query('ALTER TYPE "enum_Collections_status" RENAME VALUE \'SELECTION\' TO \'SELECTING\';');
};

export const down = async ({ context: queryInterface }) => {
    await queryInterface.removeColumn("Collections", "clientEmail");
    await queryInterface.removeColumn("Collections", "clientName");
    // Reverting the id column back to an auto-incrementing integer and the enum value
    // rename is not supported cleanly by Postgres; run `npm run init-db-dev` to reset instead.
};
