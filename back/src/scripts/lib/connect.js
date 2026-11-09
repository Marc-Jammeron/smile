import { Sequelize } from "sequelize";

// Connection for maintenance scripts. Deliberately NOT db.repository.js: importing that
// module runs the pending migrations, and these scripts exist to be run BEFORE the unique
// index migration (which refuses to run while duplicates exist).
export const connectWithoutMigrations = () => {
    const { DB_NAME, DB_USER, DB_PWD, DB_HOST, DB_PORT } = process.env;
    if (!DB_NAME || !DB_USER || !DB_HOST) {
        throw new Error("DB_NAME, DB_USER and DB_HOST must be set (run with: node --env-file=.env ...)");
    }
    const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PWD, { host: DB_HOST, port: DB_PORT, dialect: "postgres", logging: false });
    return { sequelize, target: { database: DB_NAME, host: DB_HOST } };
};
