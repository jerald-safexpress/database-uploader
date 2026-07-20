# Database Uploader

Automatically dumps one or more **MySQL** databases and uploads the backups to
**Amazon S3**, every **3 hours**.

## How it works

1. `mysqldump` (pure JS, no external binary needed) exports each database to a
   `.sql.gz` file in `./backups`.
2. The file is uploaded to your S3 bucket under `S3_PREFIX/`.
3. The local copy is deleted after a successful upload (configurable).
4. A cron scheduler (`node-cron`) runs every 3 hours and **alternates** two
   fixed S3 object names so only two copies exist per database:

| Time window (Asia/Singapore) | S3 filename              |
| ---------------------------- | ------------------------ |
| 00:00, 06:00, 12:00, 18:00   | `DatabaseName_1st.sql.gz` |
| 03:00, 09:00, 15:00, 21:00   | `DatabaseName_2nd.sql.gz` |

Each upload **overwrites** the previous file in that slot.

Example for `ESV_EXPRESS_WMS`:

- `s3://bucket/ESV_EXPRESS_WMS_1st.sql.gz`
- `s3://bucket/ESV_EXPRESS_WMS_2nd.sql.gz`

## Setup

```bash
cd /var/www/html/database-uploader
npm install
```

Then open `.env` and fill in the required values. **You must set:**

- `S3_BUCKET` – the destination S3 bucket name.

Add the databases to back up in `databases.json`:

```json
[
  { "name": "ESV_EXPRESS_WMS" },
  { "name": "UNICEF_EXPRESS_WMS" }
]
```

To add more later, append another `{ "name": "..." }` entry to the array.

## Usage

Run a backup right now (test) — uses the current 3-hour slot (`1st` or `2nd`):

```bash
npm run backup
```

Start the scheduler + log API (keeps running, fires every 3 hours):

```bash
npm start
```

## Logs GET API

When the app is running (`npm start` or PM2), use these **GET** endpoints
(default port **3050**):

| Method | URL | Description |
| ------ | --- | ----------- |
| `GET` | `/api/backups` | List S3 uploads (Database Name + Date/Time) |
| `GET` | `/api/backups/view` | HTML table of S3 uploads |
| `GET` | `/api/logs` | Recent log entries (JSON) |
| `GET` | `/api/logs?limit=50&level=error` | Filter logs |
| `GET` | `/api/logs/runs` | Backup run history |
| `GET` | `/api/logs/raw` | Raw `backup.log` text |
| `GET` | `/api/status` | Current slot + databases |
| `GET` | `/api/health` | Health check |
| `GET` | `/logs/view` | Browser log viewer (HTML) |

Aliases without `/api` also work: `/logs`, `/logs/runs`, `/health`, `/status`.

```bash
# start (scheduler + API)
npm start

# call the GET logs API
curl http://localhost:3050/api/logs
curl http://localhost:3050/api/logs/runs
curl http://localhost:3050/api/status
```

Open in a browser: `http://YOUR_SERVER_IP:3050/logs/view`  
(open port **3050** in the AWS security group, or use an SSH tunnel).

API-only (no cron):

```bash
npm run api
```

## Configuration (.env)

| Variable                    | Description                                         | Default            |
| --------------------------- | --------------------------------------------------- | ------------------ |
| `DB_HOST`                   | MySQL host                                          | —                  |
| `DB_PORT`                   | MySQL port                                          | `3306`             |
| `DB_USER`                   | MySQL user                                          | —                  |
| `DB_PASSWORD`               | MySQL password                                      | —                  |
| `DB_NAME`                   | Single-database fallback if `databases.json` absent | —                  |
| `DATABASES_FILE`            | Path to database list JSON                          | `./databases.json` |
| `AWS_REGION`                | S3 region                                           | `ap-southeast-1`   |
| `AWS_ACCESS_KEY_ID`         | AWS access key                                      | —                  |
| `AWS_SECRET_ACCESS_KEY`     | AWS secret key                                      | —                  |
| `S3_BUCKET`                 | Destination bucket (**required**)                   | —                  |
| `S3_PREFIX`                 | Folder prefix inside the bucket                     | _(empty)_          |
| `CRON_SCHEDULE`             | Cron expression                                     | `0 */3 * * *`      |
| `TZ`                        | Timezone for schedule + 1st/2nd slot                | `Asia/Singapore`   |
| `BACKUP_DIR`                | Local dump folder                                   | `./backups`        |
| `DELETE_LOCAL_AFTER_UPLOAD` | Delete local dump after upload                      | `true`             |
| `GZIP`                      | Gzip the dump before uploading                      | `true`             |
| `LOG_DIR`                   | Folder for log files                                | `./logs`           |
| `API_PORT`                  | HTTP port for the log GET API                       | `3050`             |
| `API_HOST`                  | HTTP bind address                                   | `0.0.0.0`          |

## Running 24/7 on Linux

`npm start` only runs while the terminal is open. To keep it running in the
background and restart on boot, use **PM2**:

```bash
sudo npm install -g pm2
pm2 start index.js --name database-uploader
pm2 save
pm2 startup
```

## Security note

The credentials live in `.env`, which is excluded from git via `.gitignore`.
Do not commit `.env` to GitHub.
