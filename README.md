# Database Uploader

Automatically dumps a **MySQL** database and uploads the backup to **Amazon S3**,
every day at **05:00 AM**.

## How it works

1. `mysqldump` (pure JS, no external binary needed) exports the database to a
   `.sql.gz` file in `./backups`.
2. The file is uploaded to your S3 bucket under `S3_PREFIX/`.
3. The local copy is deleted after a successful upload (configurable).
4. A cron scheduler (`node-cron`) triggers the whole run daily at 05:00 AM.

## Setup

```bash
cd C:\nginx\html\database-uploader
npm install
```

Then open `.env` and fill in the required values. **You must set:**

- `DB_NAME` – the name of the database to back up.
- `S3_BUCKET` – the destination S3 bucket name.

All other values are pre-filled from what you provided.

## Usage

Run a backup right now (test):

```bash
npm run backup
```

Start the scheduler (keeps running, fires daily at 05:00 AM):

```bash
npm start
```

## Configuration (.env)

| Variable                    | Description                                        | Default            |
| --------------------------- | -------------------------------------------------- | ------------------ |
| `DB_HOST`                   | MySQL host                                         | —                  |
| `DB_PORT`                   | MySQL port                                         | `3306`             |
| `DB_USER`                   | MySQL user                                         | —                  |
| `DB_PASSWORD`               | MySQL password                                     | —                  |
| `DB_NAME`                   | Database to back up (**required**)                 | —                  |
| `AWS_REGION`                | S3 region                                          | `ap-southeast-1`   |
| `AWS_ACCESS_KEY_ID`         | AWS access key                                     | —                  |
| `AWS_SECRET_ACCESS_KEY`     | AWS secret key                                     | —                  |
| `S3_BUCKET`                 | Destination bucket (**required**)                  | —                  |
| `S3_PREFIX`                 | Folder prefix inside the bucket                    | `database-backups` |
| `CRON_SCHEDULE`             | Cron expression                                    | `0 5 * * *`        |
| `TZ`                        | Timezone for the schedule                          | `Asia/Singapore`   |
| `BACKUP_DIR`                | Local dump folder                                  | `./backups`        |
| `DELETE_LOCAL_AFTER_UPLOAD` | Delete local dump after upload                     | `true`             |
| `GZIP`                      | Gzip the dump before uploading                     | `true`             |

## Running 24/7 on Windows

`npm start` only runs while the terminal is open. To keep it running in the
background and restart on boot, use one of:

- **PM2** (recommended):

  ```bash
  npm install -g pm2 pm2-windows-startup
  pm2 start index.js --name database-uploader
  pm2 save
  pm2-startup install
  ```

- **Windows Task Scheduler**: create a task that runs
  `node C:\nginx\html\database-uploader\index.js` at logon (for the scheduler),
  or run `node index.js --now` directly at 05:00 AM daily (no need to keep a
  process alive).

## Security note

The credentials live in `.env`, which is excluded from git via `.gitignore`.
Because these credentials were shared in plain text, rotate the AWS access key
and the database password once everything works.
