import { Sequelize, DataTypes } from "sequelize";
import { Umzug, SequelizeStorage } from "umzug";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import CollectionModel from "../model/collection.model.js";
import PhotoModel from "../model/photos.model.js";
import PhotoAttachmentModel from "../model/photo-attachment.model.js";
import GallerySettingsModel from "../model/gallery-settings.model.js";
import logger from "../logger.js";

const log = logger.child("db");
const sqlLog = log.child("sql");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const maskSqlLiterals = (sql) => sql.replace(/'(?:[^']|'')*'/g, "'?'");

const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PWD,
    {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        dialect: "postgres",
        // Les requêtes SQL ne sont tracées qu'en debug, et sans leurs valeurs littérales :
        // un WHERE "accessToken" = '...' ferait fuiter le jeton d'accès client.
        logging: sqlLog.isLevelEnabled("debug")
            ? (sql, durationMs) => sqlLog.debug(maskSqlLiterals(sql), { durationMs })
            : false,
        benchmark: true
    }
);

log.info("Connecting to database", {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER
});

try {
    await sequelize.authenticate();
    log.info("Database connection established");
} catch (error) {
    log.error("Unable to connect to the database, exiting", error, { host: process.env.DB_HOST, port: process.env.DB_PORT });
    process.exit(1);
}

const migrationLog = log.child("migrations");

const umzug = new Umzug({
    migrations: {
        glob: path.join(__dirname, "../migrations/*.js").replace(/\\/g, "/"),
        resolve: ({ name, path: migrationPath, context }) => ({
            name,
            up: async () => (await import(pathToFileURL(migrationPath).href)).up({ context }),
            down: async () => (await import(pathToFileURL(migrationPath).href)).down({ context })
        })
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    // Umzug passe des objets { event, name, ... } : on garde l'événement comme message.
    logger: Object.fromEntries(["debug", "info", "warn", "error"].map(level => [
        level,
        ({ event, ...details }) => migrationLog[level](`Migration ${event ?? level}`, details)
    ]))
});

try {
    const pending = await umzug.pending();
    log.info("Applying database migrations", { pending: pending.length });
    const applied = await umzug.up();
    log.info("Database migrations applied", { applied: applied.map(({ name }) => name) });
} catch (error) {
    log.error("Failed to apply database migrations, exiting", error);
    process.exit(1);
}

const Collection = CollectionModel(sequelize, DataTypes);
const Photo = PhotoModel(sequelize, DataTypes);
const PhotoAttachment = PhotoAttachmentModel(sequelize, DataTypes);
const GallerySettings = GallerySettingsModel(sequelize, DataTypes);

Collection.hasMany(Photo, { foreignKey: "collectionId" });
Photo.belongsTo(Collection, { foreignKey: "collectionId" });

Photo.hasMany(PhotoAttachment, { foreignKey: "photoId" });
PhotoAttachment.belongsTo(Photo, { foreignKey: "photoId" });

const db = {
    sequelize,
    umzug,
    Collection,
    Photo,
    PhotoAttachment,
    GallerySettings
};

export default db;