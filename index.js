require("dotenv").config();
const cron = require("node-cron");
const { runBackup } = require("./backup");

const schedule = process.env.CRON_SCHEDULE || "0 5 * * *";
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

  console.log("Database uploader started.");
  console.log(`Schedule: "${schedule}" (timezone: ${timezone})`);
  console.log("Waiting for the next scheduled run. Press Ctrl+C to stop.");

  cron.schedule(
    schedule,
    () => {
      runBackup().catch((err) =>
        console.error(`[error] Scheduled backup failed: ${err.message}`)
      );
    },
    { timezone }
  );
}
