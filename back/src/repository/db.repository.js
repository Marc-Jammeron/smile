import { Sequelize, DataTypes } from "sequelize";
import { Umzug, SequelizeStorage } from "umzug";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import CollectionModel from "../model/collection.model.js";
import PhotoModel from "../model/photos.model.js";
import PhotoAttachmentModel from "../model/photo-attachment.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PWD,
    {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        dialect: "postgres",
        logging: false
    }
);

try {
    await sequelize.authenticate();
    console.log("Connection has been established successfully.");
} catch (error) {
    console.error("Unable to connect to the database:", error);
    console.error("kill the process");
    process.exit(1);
}

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
    logger: console
});

try {
    await umzug.up();
    console.log("Database migrations applied successfully.");
} catch (error) {
    console.error("Failed to apply database migrations:", error);
    process.exit(1);
}

const Collection = CollectionModel(sequelize, DataTypes);
const Photo = PhotoModel(sequelize, DataTypes);
const PhotoAttachment = PhotoAttachmentModel(sequelize, DataTypes);

Collection.hasMany(Photo, { foreignKey: "collectionId" });
Photo.belongsTo(Collection, { foreignKey: "collectionId" });

Photo.hasMany(PhotoAttachment, { foreignKey: "photoId" });
PhotoAttachment.belongsTo(Photo, { foreignKey: "photoId" });

const db = {
    sequelize,
    umzug,
    Collection,
    Photo,
    PhotoAttachment
};

export default db;