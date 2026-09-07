import db from "../repository/db.repository.js";

const { umzug, Collection, Photo } = db;

const collectionsData = [
    {
        name: "Wedding - Dupont",
        clientEmail: "dupont@example.com",
        clientName: "Dupont",
        status: "SELECTING",
        description: "Wedding shoot at Chateau de Vaux, June 2026",
        maxPhotos: 30,
        photos: [
            { key: "uploads/1/1011.jpg", thumbnailKey: "uploads/1/1011-thumb.jpg", contentType: "image/jpeg", size: 245678, status: "SELECTED" },
            { key: "uploads/1/1012.jpg", thumbnailKey: "uploads/1/1012-thumb.jpg", contentType: "image/jpeg", size: 198342, status: "PENDING" },
            { key: "uploads/1/1013.jpg", thumbnailKey: "uploads/1/1013-thumb.jpg", contentType: "image/jpeg", size: 210556, status: "REJECTED" }
        ]
    },
    {
        name: "Corporate - Acme Inc",
        clientEmail: "contact@acme-inc.example.com",
        clientName: "Acme Inc",
        status: "EDITING",
        description: "Team headshots and office photos",
        maxPhotos: 15,
        photos: [
            { key: "uploads/2/1021.jpg", thumbnailKey: "uploads/2/1021-thumb.jpg", contentType: "image/jpeg", size: 176234, status: "SELECTED" },
            { key: "uploads/2/1022.jpg", thumbnailKey: "uploads/2/1022-thumb.jpg", contentType: "image/jpeg", size: 182910, status: "SELECTED" }
        ]
    },
    {
        name: "Family - Martin",
        clientEmail: "martin@example.com",
        clientName: "Martin",
        status: "DRAFT",
        description: "Family portrait session in the park",
        maxPhotos: 10,
        photos: [
            { key: "uploads/3/1031.jpg", thumbnailKey: "uploads/3/1031-thumb.jpg", contentType: "image/jpeg", size: 203145, status: "PENDING" }
        ]
    }
];

async function initDbDev() {
    await umzug.down({ to: 0 });
    await umzug.up();
    console.log("Database schema reset via migrations.");

    for (const { photos, ...collectionAttrs } of collectionsData) {
        const collection = await Collection.create(collectionAttrs);
        await Photo.bulkCreate(
            photos.map((photo) => ({ ...photo, collectionId: collection.id }))
        );
    }

    console.log(`Seeded ${collectionsData.length} collections.`);
}

initDbDev()
    .then(() => {
        console.log("Dev database initialized successfully.");
        process.exit(0);
    })
    .catch((error) => {
        console.error("Failed to initialize dev database:", error);
        process.exit(1);
    });
