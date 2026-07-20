const http = require("http");
const { URL } = require("url");
const { readLogLines, readRawLog, loadRuns, LOG_DIR, LOG_FILE } = require("./logger");
const { getBackupSlot, loadDatabases, getNextBackupInfo } = require("./backup");
const { listS3Backups } = require("./s3List");

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(html);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getLogs(url) {
  const limit = url.searchParams.get("limit") || 100;
  const level = url.searchParams.get("level") || undefined;
  const entries = readLogLines({ limit, level });
  return { count: entries.length, entries };
}

function getRuns(url) {
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 200));
  const runs = loadRuns().slice(0, limit);
  return { count: runs.length, runs };
}

function getStatus() {
  let databases = [];
  try {
    databases = loadDatabases().map((d) => d.name);
  } catch (err) {
    databases = { error: err.message };
  }
  return {
    time: new Date().toISOString(),
    timezone: process.env.TZ || "Asia/Singapore",
    schedule: process.env.CRON_SCHEDULE || "0 */3 * * *",
    currentSlot: getBackupSlot(),
    nextBackup: getNextBackupInfo(),
    databases,
    logDir: LOG_DIR,
    logFile: LOG_FILE,
    s3Bucket: process.env.S3_BUCKET || null,
  };
}

function backupsTableHtml(data, nextBackup) {
  const rows = (data.backups || [])
    .map(
      (b) => `<tr>
      <td>${escapeHtml(b.databaseName)}</td>
      <td>${escapeHtml(b.slot || "—")}</td>
      <td>${escapeHtml(b.uploadedAtLocal || b.uploadedAt || "—")}</td>
      <td>${escapeHtml(b.fileName)}</td>
      <td>${escapeHtml(b.sizeKb)} KB</td>
    </tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>S3 Backup List</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #1a1a1a; }
    h1 { margin: 0 0 8px; font-size: 1.4rem; }
    .meta { color: #666; margin-bottom: 16px; }
    .countdown {
      display: flex; flex-wrap: wrap; gap: 16px 28px; align-items: center;
      background: #0f172a; color: #f8fafc; border-radius: 12px;
      padding: 18px 22px; margin: 0 0 20px; max-width: 1100px;
    }
    .countdown .label { font-size: 0.85rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .countdown .timer { font-size: 2rem; font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: 0.02em; }
    .countdown .detail { font-size: 0.95rem; color: #cbd5e1; }
    .countdown .detail strong { color: #fff; }
    table { border-collapse: collapse; width: 100%; max-width: 1100px; }
    th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }
    th { background: #f5f5f5; }
    tr:nth-child(even) { background: #fafafa; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
  <h1>S3 Backups — Uploaded Databases</h1>
  <p class="meta">
    Bucket: <strong>${escapeHtml(data.bucket)}</strong>
    · ${data.count} file(s)
    · timezone ${escapeHtml(data.timezone)}
    · <a href="/api/backups">JSON</a>
    · <a href="/logs/view">Logs</a>
  </p>

  <div class="countdown" id="countdown"
       data-next-at="${escapeHtml(nextBackup.nextAt)}"
       data-next-local="${escapeHtml(nextBackup.nextAtLocal)}"
       data-next-slot="${escapeHtml(nextBackup.nextSlot)}"
       data-schedule="${escapeHtml(nextBackup.schedule)}"
       data-timezone="${escapeHtml(nextBackup.timezone)}">
    <div>
      <div class="label">Next backup in</div>
      <div class="timer" id="timer">--:--:--</div>
    </div>
    <div class="detail">
      Scheduled: <strong id="nextLocal">${escapeHtml(nextBackup.nextAtLocal)}</strong>
      (${escapeHtml(nextBackup.timezone)})<br />
      Slot: <strong id="nextSlot">${escapeHtml(nextBackup.nextSlot)}</strong>
      · Cron: <code>${escapeHtml(nextBackup.schedule)}</code>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Database Name</th>
        <th>Slot</th>
        <th>Date and Time Uploaded</th>
        <th>File</th>
        <th>Size</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="5">No backups found in S3.</td></tr>`}
    </tbody>
  </table>

  <script>
    (function () {
      const el = document.getElementById('countdown');
      const timerEl = document.getElementById('timer');
      const nextLocalEl = document.getElementById('nextLocal');
      const nextSlotEl = document.getElementById('nextSlot');
      let nextAt = new Date(el.dataset.nextAt).getTime();

      function pad(n) { return String(n).padStart(2, '0'); }

      function render() {
        const ms = nextAt - Date.now();
        if (ms <= 0) {
          timerEl.textContent = '00:00:00';
          timerEl.style.color = '#4ade80';
          // Refresh page shortly after due time so list + next countdown update
          setTimeout(function () { location.reload(); }, 2000);
          return;
        }
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        timerEl.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
      }

      render();
      setInterval(render, 1000);
    })();
  </script>
</body>
</html>`;
}

function logsViewerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Database Uploader Logs</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; line-height: 1.4; }
    h1 { margin: 0 0 8px; font-size: 1.4rem; }
    .meta { color: #666; margin-bottom: 16px; }
    .tabs button { margin-right: 8px; padding: 6px 12px; cursor: pointer; }
    pre { background: #111; color: #eee; padding: 12px; overflow: auto; border-radius: 8px; max-height: 70vh; }
  </style>
</head>
<body>
  <h1>Database Uploader — Logs</h1>
  <p class="meta">
    GET API · refresh every 15s ·
    <a href="/api/logs">/api/logs</a> ·
    <a href="/api/backups">/api/backups</a> ·
    <a href="/api/backups/view">S3 list</a>
  </p>
  <div class="tabs">
    <button type="button" data-src="/api/logs?limit=100">Logs</button>
    <button type="button" data-src="/api/logs/runs?limit=20">Runs</button>
    <button type="button" data-src="/api/backups">S3 Backups</button>
    <button type="button" data-src="/api/status">Status</button>
    <button type="button" data-src="/api/logs/raw" data-raw="1">Raw</button>
  </div>
  <pre id="out">Loading…</pre>
  <script>
    const out = document.getElementById('out');
    let src = '/api/logs?limit=100';
    let raw = false;
    async function load() {
      try {
        const res = await fetch(src);
        const text = raw ? await res.text() : JSON.stringify(await res.json(), null, 2);
        out.textContent = text;
      } catch (e) {
        out.textContent = 'Error: ' + e.message;
      }
    }
    document.querySelectorAll('.tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        src = btn.dataset.src;
        raw = btn.dataset.raw === '1';
        load();
      });
    });
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, {
        error: "Method not allowed",
        hint: "Use GET /api/logs or GET /api/backups",
      });
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathName = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (pathName === "/" || pathName === "/api") {
        return sendJson(res, 200, {
          name: "database-uploader",
          message: "Logs + S3 backups GET API",
          endpoints: {
            "GET /api/backups": "List S3 uploads (Database Name + Date/Time)",
            "GET /api/backups/view": "HTML table of S3 uploads",
            "GET /api/logs": "Recent log entries (JSON). ?limit=&level=",
            "GET /api/logs/runs": "Backup run history (JSON). ?limit=",
            "GET /api/logs/raw": "Raw backup.log text",
            "GET /api/status": "Current slot, databases, schedule",
            "GET /api/health": "Health check",
            "GET /logs/view": "Browser log viewer (HTML)",
          },
        });
      }

      if (pathName === "/logs/view" || pathName === "/view") {
        return sendHtml(res, 200, logsViewerHtml());
      }

      if (pathName === "/health" || pathName === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          time: new Date().toISOString(),
        });
      }

      if (pathName === "/status" || pathName === "/api/status") {
        return sendJson(res, 200, getStatus());
      }

      if (pathName === "/logs" || pathName === "/api/logs") {
        return sendJson(res, 200, getLogs(url));
      }

      if (pathName === "/logs/raw" || pathName === "/api/logs/raw") {
        const raw = readRawLog();
        return sendText(res, 200, raw || "(no logs yet)\n");
      }

      if (pathName === "/logs/runs" || pathName === "/api/logs/runs") {
        return sendJson(res, 200, getRuns(url));
      }

      // S3 backup list (JSON) — for Angular / Postman
      if (pathName === "/backups" || pathName === "/api/backups") {
        const data = await listS3Backups();
        const nextBackup = getNextBackupInfo();
        const list = data.backups.map((b) => ({
          databaseName: b.databaseName,
          slot: b.slot,
          dateTimeUploaded: b.uploadedAtLocal || b.uploadedAt,
          uploadedAtUtc: b.uploadedAt,
          fileName: b.fileName,
          sizeKb: b.sizeKb,
          sizeBytes: b.sizeBytes,
          s3Key: b.s3Key,
        }));
        return sendJson(res, 200, {
          success: true,
          bucket: data.bucket,
          timezone: data.timezone,
          count: list.length,
          nextBackup: {
            nextAt: nextBackup.nextAt,
            nextAtLocal: nextBackup.nextAtLocal,
            nextSlot: nextBackup.nextSlot,
            schedule: nextBackup.schedule,
            timezone: nextBackup.timezone,
            msUntil: nextBackup.msUntil,
          },
          data: list,
        });
      }

      // S3 backup list (HTML table)
      if (pathName === "/backups/view" || pathName === "/api/backups/view") {
        const data = await listS3Backups();
        const nextBackup = getNextBackupInfo();
        return sendHtml(res, 200, backupsTableHtml(data, nextBackup));
      }

      return sendJson(res, 404, {
        error: "Not found",
        path: pathName,
        try: ["/api/backups", "/api/backups/view", "/api/logs", "/api/health"],
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });
}

function startApiServer() {
  const port = Number(process.env.API_PORT || 3050);
  const host = process.env.API_HOST || "0.0.0.0";
  const server = createServer();

  server.listen(port, host, () => {
    console.log(`[api] Log API listening on http://${host}:${port}`);
    console.log(`[api] GET  http://localhost:${port}/api/backups`);
    console.log(`[api] VIEW http://localhost:${port}/api/backups/view`);
    console.log(`[api] GET  http://localhost:${port}/api/logs`);
  });

  return server;
}

module.exports = { createServer, startApiServer };
