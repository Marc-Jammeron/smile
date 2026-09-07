export const up = async ({ context: queryInterface }) => {
    await queryInterface.sequelize.query('ALTER TYPE "enum_Photos_status" ADD VALUE IF NOT EXISTS \'ARCHIVED\';');
};

export const down = async () => {
    // Postgres does not support removing a value from an enum type.
};
