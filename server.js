const http = require("http");
const { URL } = require("url");
const { readLogLines, readRawLog, loadRuns, LOG_DIR } = require("./logger");
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
      return sendJson(res, 405, { error: "Method not allowed. Use GET." });
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathName = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (pathName === "/" || pathName === "/api") {
        return sendJson(res, 200, {
          name: "database-uploader",
          endpoints: {
            "GET /health": "Service health",
            "GET /logs": "Recent log entries (JSON). Query: limit, level",
            "GET /logs/raw": "Raw backup.log text",
            "GET /logs/runs": "Backup run history (JSON). Query: limit",
            "GET /status": "Current slot, databases, schedule",
          },
        });
      }

      if (pathName === "/health") {
        return sendJson(res, 200, {
          ok: true,
          time: new Date().toISOString(),
        });
      }

      if (pathName === "/status") {
        let databases = [];
        try {
          databases = loadDatabases().map((d) => d.name);
        } catch (err) {
          databases = { error: err.message };
        }
        return sendJson(res, 200, {
          time: new Date().toISOString(),
          timezone: process.env.TZ || "Asia/Singapore",
          schedule: process.env.CRON_SCHEDULE || "0 */3 * * *",
          currentSlot: getBackupSlot(),
          databases,
          logDir: LOG_DIR,
          s3Bucket: process.env.S3_BUCKET || null,
        });
      }

      if (pathName === "/logs") {
        const limit = url.searchParams.get("limit") || 100;
        const level = url.searchParams.get("level") || undefined;
        const entries = readLogLines({ limit, level });
        return sendJson(res, 200, {
          count: entries.length,
          entries,
        });
      }

      if (pathName === "/logs/raw") {
        const raw = readRawLog();
        return sendText(res, 200, raw || "(no logs yet)\n");
      }

      if (pathName === "/logs/runs") {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 200));
        const runs = loadRuns().slice(0, limit);
        return sendJson(res, 200, {
          count: runs.length,
          runs,
        });
      }

      return sendJson(res, 404, { error: "Not found", path: pathName });
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
    console.log(`[api] GET http://localhost:${port}/logs`);
    console.log(`[api] GET http://localhost:${port}/logs/runs`);
  });

  return server;
}

module.exports = { createServer, startApiServer };
