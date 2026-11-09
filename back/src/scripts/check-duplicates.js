// READ-ONLY. Lists the duplicates that would block the unique-index migration.
//   npm run check-duplicates
// Exit code 0 = no blocking duplicate, 1 = duplicates found, 2 = could not run.
import { connectWithoutMigrations } from "./lib/connect.js";
import { findDuplicatePhotos, findDuplicateAttachments, findSameFilenameUploads, planPhotoPurge, formatPlan } from "./lib/duplicates.js";

const main = async () => {
    const { sequelize, target } = connectWithoutMigrations();
    try {
        console.log(`Checking database "${target.database}" on ${target.host} (read-only)`);
        const photoGroups = await findDuplicatePhotos(sequelize);
        const attachmentGroups = await findDuplicateAttachments(sequelize);
        const sameFilename = await findSameFilenameUploads(sequelize);
        console.log(formatPlan({ photoPlan: planPhotoPurge(photoGroups), attachmentGroups, sameFilename }));
        const blocking = photoGroups.length + attachmentGroups.length;
        console.log(blocking === 0 ? "\nOK: nothing blocks the unique-index migration." : `\n${blocking} blocking group(s). Back up the database, then run: npm run purge-duplicates`);
        return blocking === 0 ? 0 : 1;
    } finally {
        await sequelize.close();
    }
};

main().then((code) => process.exit(code), (error) => {
    console.error(`check-duplicates failed: ${error.message}`);
    process.exit(2);
});
