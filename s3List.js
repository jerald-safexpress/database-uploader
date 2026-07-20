const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function formatDateTime(date, timeZone = process.env.TZ || "Asia/Singapore") {
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Parse keys like:
 *   ESV_EXPRESS_WMS_1st.sql.gz
 *   ESV_EXPRESS_WMS_2nd.sql.gz
 *   ESV_EXPRESS_WMS_2026-07-06_17-30-30.sql.gz
 */
function parseBackupKey(key) {
  const fileName = key.split("/").pop() || key;
  const match = fileName.match(/^(.*?)_(1st|2nd)(?:\.sql(?:\.gz)?)?$/i);
  if (match) {
    return {
      databaseName: match[1],
      slot: match[2].toLowerCase(),
      fileName,
    };
  }

  const tsMatch = fileName.match(/^(.*)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:\.sql(?:\.gz)?)?$/);
  if (tsMatch) {
    return {
      databaseName: tsMatch[1],
      slot: null,
      fileName,
    };
  }

  return {
    databaseName: fileName.replace(/\.sql(\.gz)?$/i, ""),
    slot: null,
    fileName,
  };
}

async function listS3Backups() {
  const region = requireEnv("AWS_REGION");
  const bucket = requireEnv("S3_BUCKET");
  const prefix = (process.env.S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
  const timeZone = process.env.TZ || "Asia/Singapore";

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });

  const backups = [];
  let continuationToken;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix ? `${prefix}/` : undefined,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of response.Contents || []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue;
      const parsed = parseBackupKey(obj.Key);
      const uploadedAt = obj.LastModified ? new Date(obj.LastModified) : null;
      backups.push({
        databaseName: parsed.databaseName,
        slot: parsed.slot,
        fileName: parsed.fileName,
        s3Key: obj.Key,
        sizeBytes: obj.Size || 0,
        sizeKb: Number(((obj.Size || 0) / 1024).toFixed(1)),
        uploadedAt: uploadedAt ? uploadedAt.toISOString() : null,
        uploadedAtLocal: formatDateTime(uploadedAt, timeZone),
      });
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  backups.sort((a, b) => {
    const ta = a.uploadedAt ? Date.parse(a.uploadedAt) : 0;
    const tb = b.uploadedAt ? Date.parse(b.uploadedAt) : 0;
    return tb - ta;
  });

  return {
    bucket,
    prefix: prefix || null,
    timezone: timeZone,
    count: backups.length,
    backups,
  };
}

module.exports = { listS3Backups, formatDateTime, parseBackupKey };
