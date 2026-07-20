const http = require("http");
const { URL } = require("url");
const { readLogLines, readRawLog, loadRuns, LOG_DIR, LOG_FILE } = require("./logger");
const { getBackupSlot, loadDatabases } = require("./backup");

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
    databases,
    logDir: LOG_DIR,
    logFile: LOG_FILE,
    s3Bucket: process.env.S3_BUCKET || null,
  };
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
    .ok { color: #1a7f37; }
    .err { color: #cf222e; }
  </style>
</head>
<body>
  <h1>Database Uploader — Logs</h1>
  <p class="meta">GET API · refresh every 15s · <a href="/api/logs">/api/logs</a> · <a href="/api/logs/runs">/api/logs/runs</a></p>
  <div class="tabs">
    <button type="button" data-src="/api/logs?limit=100">Logs</button>
    <button type="button" data-src="/api/logs/runs?limit=20">Runs</button>
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
  return http.createServer((req, res) => {
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
        hint: "Use GET /api/logs or GET /logs",
      });
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathName = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // Home / docs
      if (pathName === "/" || pathName === "/api") {
        return sendJson(res, 200, {
          name: "database-uploader",
          message: "Logs GET API",
          endpoints: {
            "GET /api/logs": "Recent log entries (JSON). ?limit=&level=",
            "GET /api/logs/runs": "Backup run history (JSON). ?limit=",
            "GET /api/logs/raw": "Raw backup.log text",
            "GET /api/status": "Current slot, databases, schedule",
            "GET /api/health": "Health check",
            "GET /logs/view": "Browser log viewer (HTML)",
            "GET /logs": "Alias of /api/logs",
            "GET /logs/runs": "Alias of /api/logs/runs",
            "GET /health": "Alias of /api/health",
            "GET /status": "Alias of /api/status",
          },
        });
      }

      // HTML viewer
      if (pathName === "/logs/view" || pathName === "/view") {
        return sendHtml(res, 200, logsViewerHtml());
      }

      // Health
      if (pathName === "/health" || pathName === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          time: new Date().toISOString(),
        });
      }

      // Status
      if (pathName === "/status" || pathName === "/api/status") {
        return sendJson(res, 200, getStatus());
      }

      // GET logs (JSON)
      if (pathName === "/logs" || pathName === "/api/logs") {
        return sendJson(res, 200, getLogs(url));
      }

      // GET raw log file
      if (pathName === "/logs/raw" || pathName === "/api/logs/raw") {
        const raw = readRawLog();
        return sendText(res, 200, raw || "(no logs yet)\n");
      }

      // GET run history
      if (pathName === "/logs/runs" || pathName === "/api/logs/runs") {
        return sendJson(res, 200, getRuns(url));
      }

      return sendJson(res, 404, {
        error: "Not found",
        path: pathName,
        try: ["/api/logs", "/api/logs/runs", "/logs/view", "/api/health"],
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
    console.log(`[api] GET  http://localhost:${port}/api/logs`);
    console.log(`[api] GET  http://localhost:${port}/api/logs/runs`);
    console.log(`[api] VIEW http://localhost:${port}/logs/view`);
  });

  return server;
}

module.exports = { createServer, startApiServer };
