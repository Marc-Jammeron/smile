// Removes duplicate Photo / PhotoAttachment ROWS (database only, S3 is never touched).
// DRY-RUN by default: it prints the plan and changes nothing.
//   npm run purge-duplicates                 # plan only
//   npm run purge-duplicates -- --apply      # executes, in one transaction
// Take a database backup first. Groups it cannot decide on its own are left for a human.
import { connectWithoutMigrations } from "./lib/connect.js";
import { findDuplicatePhotos, findDuplicateAttachments, planPhotoPurge, formatPlan, applyPurge, parsePurgeArgs } from "./lib/duplicates.js";

const main = async () => {
    const { apply } = parsePurgeArgs(process.argv.slice(2));
    const { sequelize, target } = connectWithoutMigrations();
    try {
        console.log(`${apply ? "APPLYING on" : "Dry-run on"} database "${target.database}" on ${target.host}`);
        const photoPlan = planPhotoPurge(await findDuplicatePhotos(sequelize));
        const attachmentGroups = await findDuplicateAttachments(sequelize);
        console.log(formatPlan({ photoPlan, attachmentGroups }));

        if (!apply) {
            console.log("\nDry-run: nothing was changed. Re-run with --apply (after a database backup) to execute this plan.");
            return 0;
        }
        const report = await applyPurge(sequelize, photoPlan);
        console.log(`\nDone: ${report.deletedPhotos} photo row(s) deleted, ${report.movedAttachments} attachment(s) moved, ${report.deletedAttachments} duplicate attachment row(s) deleted.`);
        const review = photoPlan.filter((entry) => entry.action === "review").length;
        if (review > 0) {
            console.log(`${review} group(s) still need a manual decision (see REVIEW above).`);
            return 1;
        }
        return 0;
    } finally {
        await sequelize.close();
    }
};

main().then((code) => process.exit(code), (error) => {
    console.error(`purge-duplicates failed (nothing applied): ${error.message}`);
    process.exit(2);
});
