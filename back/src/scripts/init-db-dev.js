import db from "../repository/db.repository.js";
import logger from "../logger.js";

const log = logger.child("init-db-dev");

const { umzug, Collection, Photo } = db;

const collectionsData = [
    {
        name: "Wedding - Dupont",
        clientName: "Dupont",
        status: "SELECTING",
        clientMessage: "Merci de choisir vos photos préférées avant la fin du mois.",
        maxPhotos: 30,
        photos: [
            { key: "uploads/1/1011.jpg", thumbnailKey: "uploads/1/1011-thumb.jpg", contentType: "image/jpeg", size: 245678, status: "SELECTED" },
            { key: "uploads/1/1012.jpg", thumbnailKey: "uploads/1/1012-thumb.jpg", contentType: "image/jpeg", size: 198342, status: "PENDING" },
            { key: "uploads/1/1013.jpg", thumbnailKey: "uploads/1/1013-thumb.jpg", contentType: "image/jpeg", size: 210556, status: "REJECTED" }
        ]
    },
    {
        name: "Corporate - Acme Inc",
        clientName: "Acme Inc",
        status: "EDITING",
        maxPhotos: 15,
        photos: [
            { key: "uploads/2/1021.jpg", thumbnailKey: "uploads/2/1021-thumb.jpg", contentType: "image/jpeg", size: 176234, status: "SELECTED" },
            { key: "uploads/2/1022.jpg", thumbnailKey: "uploads/2/1022-thumb.jpg", contentType: "image/jpeg", size: 182910, status: "SELECTED" }
        ]
    },
    {
        name: "Family - Martin",
        clientName: "Martin",
        status: "DRAFT",
        maxPhotos: 10,
        photos: [
            { key: "uploads/3/1031.jpg", thumbnailKey: "uploads/3/1031-thumb.jpg", contentType: "image/jpeg", size: 203145, status: "PENDING" }
        ]
    }
];

async function initDbDev() {
    log.warn("Resetting the database: reverting every migration");
    await umzug.down({ to: 0 });
    await umzug.up();
    log.info("Database schema reset via migrations");

    for (const { photos, ...collectionAttrs } of collectionsData) {
        const collection = await Collection.create(collectionAttrs);
        log.debug("Seeding collection", { collectionId: collection.id, name: collection.name, photoCount: photos.length });
        await Photo.bulkCreate(
            photos.map((photo, position) => ({ ...photo, position, collectionId: collection.id }))
        );
    }

    log.info("Collections seeded", { count: collectionsData.length });
}

initDbDev()
    .then(() => {
        log.info("Dev database initialized successfully");
        process.exit(0);
    })
    .catch((error) => {
        log.error("Failed to initialize dev database", error);
        process.exit(1);
    });
