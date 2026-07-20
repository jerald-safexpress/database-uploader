require("dotenv").config();
const cron = require("node-cron");
const { runBackup } = require("./backup");
const { startApiServer } = require("./server");
const { logger } = require("./logger");

const schedule = process.env.CRON_SCHEDULE || "0 */3 * * *";
const timezone = process.env.TZ || "Asia/Singapore";

// Run once immediately and exit: `npm run backup` or `node index.js --now`
if (process.argv.includes("--now")) {
  runBackup()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  if (!cron.validate(schedule)) {
    console.error(`[fatal] Invalid CRON_SCHEDULE: "${schedule}"`);
    process.exit(1);
  }

  startApiServer();

  logger.info("Database uploader started", {
    schedule,
    timezone,
    apiPort: Number(process.env.API_PORT || 3050),
  });
  console.log("Every 3 hours → alternate DatabaseName_1st / DatabaseName_2nd (overwrite).");
  console.log("Waiting for the next scheduled run. Press Ctrl+C to stop.");

  cron.schedule(
    schedule,
    () => {
      runBackup().catch((err) =>
        logger.error(`Scheduled backup failed: ${err.message}`, { error: err.message })
      );
    },
    { timezone }
  );
}
