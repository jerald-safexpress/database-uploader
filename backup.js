const fs = require("fs");
const path = require("path");
const mysqldump = require("mysqldump");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

async function dumpDatabase() {
  const host = requireEnv("DB_HOST");
  const port = Number(process.env.DB_PORT || 3306);
  const user = requireEnv("DB_USER");
  const password = process.env.DB_PASSWORD || "";
  const database = requireEnv("DB_NAME");

  const gzip = String(process.env.GZIP || "true").toLowerCase() === "true";
  const backupDir = path.resolve(process.env.BACKUP_DIR || "./backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const ext = gzip ? "sql.gz" : "sql";
  const fileName = `${database}_${timestamp()}.${ext}`;
  const filePath = path.join(backupDir, fileName);

  console.log(`[backup] Dumping "${database}" from ${host}:${port} ...`);
  await mysqldump({
    connection: { host, port, user, password, database },
    dumpToFile: filePath,
    compressFile: gzip,
  });

  const { size } = fs.statSync(filePath);
  console.log(`[backup] Dump written: ${filePath} (${(size / 1024).toFixed(1)} KB)`);
  return { filePath, fileName };
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

  console.log(`[upload] Uploading to s3://${bucket}/${key} ...`);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: fileName.endsWith(".gz") ? "application/gzip" : "application/sql",
    })
  );
  console.log(`[upload] Done: s3://${bucket}/${key}`);
  return key;
}

async function runBackup() {
  const startedAt = new Date();
  console.log(`\n===== Backup run started: ${startedAt.toISOString()} =====`);
  try {
    const { filePath, fileName } = await dumpDatabase();
    await uploadToS3(filePath, fileName);

    const deleteLocal =
      String(process.env.DELETE_LOCAL_AFTER_UPLOAD || "true").toLowerCase() === "true";
    if (deleteLocal) {
      fs.unlinkSync(filePath);
      console.log(`[cleanup] Removed local file: ${filePath}`);
    }

    console.log(`===== Backup run finished OK =====\n`);
  } catch (err) {
    console.error(`[error] Backup run failed: ${err.message}`);
    throw err;
  }
}

module.exports = { runBackup };
