const fs = require("fs");
const path = require("path");

const LOG_DIR = path.resolve(process.env.LOG_DIR || "./logs");
const LOG_FILE = path.join(LOG_DIR, "backup.log");
const RUNS_FILE = path.join(LOG_DIR, "runs.json");
const MAX_RUNS = Number(process.env.LOG_MAX_RUNS || 200);
const MAX_LOG_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024); // 5 MB

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const { size } = fs.statSync(LOG_FILE);
    if (size < MAX_LOG_BYTES) return;
    const rotated = `${LOG_FILE}.${Date.now()}.bak`;
    fs.renameSync(LOG_FILE, rotated);
  } catch {
    /* ignore rotation errors */
  }
}

function writeLine(level, message, meta = {}) {
  ensureLogDir();
  rotateIfNeeded();

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");

  const line = `[${entry.ts}] [${level}] ${message}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }

  return entry;
}

const logger = {
  info(message, meta) {
    return writeLine("info", message, meta);
  },
  error(message, meta) {
    return writeLine("error", message, meta);
  },
  warn(message, meta) {
    return writeLine("warn", message, meta);
  },
};

function readLogLines({ limit = 100, level } = {}) {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) {
    return [];
  }

  const content = fs.readFileSync(LOG_FILE, "utf8");
  let lines = content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: null, level: "info", message: line };
      }
    });

  if (level) {
    const wanted = String(level).toLowerCase();
    lines = lines.filter((e) => e.level === wanted);
  }

  const n = Math.max(1, Math.min(Number(limit) || 100, 2000));
  return lines.slice(-n).reverse();
}

function readRawLog({ maxBytes = 512 * 1024 } = {}) {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) {
    return "";
  }
  const { size } = fs.statSync(LOG_FILE);
  if (size <= maxBytes) {
    return fs.readFileSync(LOG_FILE, "utf8");
  }
  const fd = fs.openSync(LOG_FILE, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function loadRuns() {
  ensureLogDir();
  if (!fs.existsSync(RUNS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveRun(run) {
  ensureLogDir();
  const runs = loadRuns();
  runs.unshift(run);
  const trimmed = runs.slice(0, MAX_RUNS);
  fs.writeFileSync(RUNS_FILE, JSON.stringify(trimmed, null, 2), "utf8");
  return run;
}

module.exports = {
  logger,
  readLogLines,
  readRawLog,
  loadRuns,
  saveRun,
  LOG_DIR,
  LOG_FILE,
};
