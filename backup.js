const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const mysqldump = require("mysqldump");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { logger, saveRun } = require("./logger");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadDatabases() {
  const configPath = path.resolve(process.env.DATABASES_FILE || "./databases.json");

  if (fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${configPath} must be a non-empty array`);
    }

    return raw.map((entry, index) => {
      if (typeof entry === "string" && entry.trim()) {
        return { name: entry.trim() };
      }
      if (entry && typeof entry.name === "string" && entry.name.trim()) {
        return { ...entry, name: entry.name.trim() };
      }
      throw new Error(`Invalid database entry at index ${index} in ${configPath}`);
    });
  }

  const single = process.env.DB_NAME?.trim();
  if (single) {
    return [{ name: single }];
  }

  throw new Error(
    "No databases configured. Add entries to databases.json or set DB_NAME in .env"
  );
}

/**
 * Alternates every 3-hour window in the configured timezone:
 *   00–02, 06–08, 12–14, 18–20  → "1st"
 *   03–05, 09–11, 15–17, 21–23  → "2nd"
 * S3 keys are fixed (DatabaseName_1st.sql.gz / DatabaseName_2nd.sql.gz)
 * so each upload overwrites the previous file in that slot.
 */
function getBackupSlot(date = new Date()) {
  const tz = process.env.TZ || "Asia/Singapore";
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hourCycle: "h23",
  }).format(date);
  let hour = Number(hourStr);
  if (hour === 24) hour = 0;
  return Math.floor(hour / 3) % 2 === 0 ? "1st" : "2nd";
}

async function gzipFile(sourcePath, destPath) {
  await pipeline(
    fs.createReadStream(sourcePath),
    zlib.createGzip(),
    fs.createWriteStream(destPath)
  );
  fs.unlinkSync(sourcePath);
}

async function dumpDatabase(db, slot) {
  const host = db.host || requireEnv("DB_HOST");
  const port = Number(db.port || process.env.DB_PORT || 3306);
  const user = db.user || requireEnv("DB_USER");
  const password = db.password ?? process.env.DB_PASSWORD ?? "";
  const database = db.name;

  const gzip = String(process.env.GZIP || "true").toLowerCase() === "true";
  const backupDir = path.resolve(process.env.BACKUP_DIR || "./backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const ext = gzip ? "sql.gz" : "sql";
  const fileName = `${database}_${slot}.${ext}`;
  const filePath = path.join(backupDir, fileName);
  const dumpPath = gzip ? filePath.replace(/\.gz$/, "") : filePath;

  logger.info(`Dumping "${database}" from ${host}:${port}`, { database, slot, host, port });
  try {
    await mysqldump({
      connection: { host, port, user, password, database },
      dumpToFile: dumpPath,
      compressFile: false,
    });

    if (gzip) {
      await gzipFile(dumpPath, filePath);
    }
  } catch (err) {
    for (const partial of [dumpPath, filePath, `${dumpPath}.temp`, `${filePath}.temp`]) {
      if (fs.existsSync(partial)) {
        fs.unlinkSync(partial);
      }
    }
    throw err;
  }

  const { size } = fs.statSync(filePath);
  logger.info(`Dump written: ${fileName}`, {
    database,
    slot,
    fileName,
    sizeBytes: size,
    sizeKb: Number((size / 1024).toFixed(1)),
  });
  return { filePath, fileName, size };
}

async function uploadToS3(filePath, fileName) {
  const region = requireEnv("AWS_REGION");
  const bucket = requireEnv("S3_BUCKET");
  const prefix = (process.env.S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
  const key = prefix ? `${prefix}/${fileName}` : fileName;

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });

  logger.info(`Uploading to s3://${bucket}/${key}`, { bucket, key, fileName });
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: fileName.endsWith(".gz") ? "application/gzip" : "application/sql",
    })
  );
  logger.info(`Upload done: s3://${bucket}/${key}`, { bucket, key });
  return key;
}

async function backupDatabase(db, slot) {
  const { filePath, fileName, size } = await dumpDatabase(db, slot);
  const s3Key = await uploadToS3(filePath, fileName);

  const deleteLocal =
    String(process.env.DELETE_LOCAL_AFTER_UPLOAD || "true").toLowerCase() === "true";
  if (deleteLocal) {
    fs.unlinkSync(filePath);
    logger.info(`Removed local file: ${fileName}`, { fileName });
  }

  return { database: db.name, slot, fileName, s3Key, sizeBytes: size, status: "ok" };
}

async function runBackup() {
  const startedAt = new Date();
  const databases = loadDatabases();
  const slot = getBackupSlot(startedAt);
  const results = [];
  const failed = [];

  logger.info("Backup run started", {
    slot,
    databaseCount: databases.length,
    databases: databases.map((d) => d.name),
  });

  for (const db of databases) {
    logger.info(`Starting database backup: ${db.name}`, { database: db.name, slot });
    try {
      const result = await backupDatabase(db, slot);
      results.push(result);
      logger.info(`Database backup OK: ${db.name}`, result);
    } catch (err) {
      logger.error(`Database backup failed: ${db.name}`, {
        database: db.name,
        slot,
        error: err.message,
      });
      failed.push({ name: db.name, error: err.message });
      results.push({ database: db.name, slot, status: "failed", error: err.message });
    }
  }

  const finishedAt = new Date();
  const run = {
    id: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    slot,
    status: failed.length > 0 ? "partial_failure" : "ok",
    total: databases.length,
    succeeded: results.filter((r) => r.status === "ok").length,
    failed: failed.length,
    results,
    failures: failed,
  };

  saveRun(run);

  if (failed.length > 0) {
    logger.error(`Backup run finished with ${failed.length} failure(s)`, {
      slot,
      failed: failed.length,
      total: databases.length,
    });
    throw new Error(`${failed.length} of ${databases.length} database backup(s) failed`);
  }

  logger.info(`Backup run finished OK`, {
    slot,
    total: databases.length,
    durationMs: run.durationMs,
  });
}

module.exports = { runBackup, loadDatabases, getBackupSlot };
