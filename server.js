"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = __dirname;
const ENTRY_FILE = "index.html";
const UPSTREAM = new URL(process.env.PICKLYONE_UPSTREAM || "https://api.picklyone.com");
const API_PREFIX = "/api/";
const API_VERSION_PREFIX = "/v1/";
const API_KEY = process.env.PICKLYONE_API_KEY;
const IMAGE_MODEL = process.env.PICKLYONE_IMAGE_MODEL || "gpt-image-2";
const REQUEST_TIMEOUT_MS = 310_000;
const ALLOWED_ORIGIN = process.env.APP_ORIGIN || "";

if (!API_KEY) {
  console.error("Missing PICKLYONE_API_KEY environment variable.");
  process.exit(1);
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    writeCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

  if (pathname === "/healthz") {
    writeCorsHeaders(req, res);
    writeJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/app-config.json") {
    writeCorsHeaders(req, res);
    writeJson(res, 200, { imageModel: IMAGE_MODEL });
    return;
  }

  if (pathname.startsWith(API_PREFIX)) {
    proxyApiRequest(req, res, pathname);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    writeCorsHeaders(req, res);
    writeJson(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  serveStatic(req, res, pathname);
});

server.timeout = REQUEST_TIMEOUT_MS + 10_000;

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
  console.log(`[server] upstream: ${UPSTREAM.origin}`);
  console.log(`[server] entry: /${ENTRY_FILE}`);
  console.log(`[server] app origin: ${ALLOWED_ORIGIN || "same-origin only"}`);
});

function proxyApiRequest(clientReq, clientRes, pathname) {
  const t0 = Date.now();
  const upstreamPath = pathname === "/api/upload"
    ? "/api/v1/upload"
    : pathname.replace(API_PREFIX, API_VERSION_PREFIX);
  const target = new URL(upstreamPath + (new URL(clientReq.url, "http://localhost").search || ""), UPSTREAM);
  const bodyOverride = shouldOverrideImageModel(target.pathname, clientReq) ? IMAGE_MODEL : "";
  const headers = {
    "authorization": `Bearer ${API_KEY}`,
    "content-type": clientReq.headers["content-type"] || "application/json",
  };
  if (clientReq.headers["user-agent"]) {
    headers["user-agent"] = clientReq.headers["user-agent"];
  }

  if (!bodyOverride) {
    if (clientReq.headers["content-length"]) {
      headers["content-length"] = clientReq.headers["content-length"];
    }
    const upstreamReq = createUpstreamRequest(clientReq, clientRes, target, headers, t0);
    clientReq.pipe(upstreamReq);
    return;
  }

  const chunks = [];
  clientReq.on("data", chunk => chunks.push(chunk));
  clientReq.on("end", () => {
    try {
      const originalBody = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(originalBody || "{}");
      payload.model = bodyOverride;
      const nextBody = JSON.stringify(payload);
      headers["content-length"] = Buffer.byteLength(nextBody);
      const upstreamReq = createUpstreamRequest(clientReq, clientRes, target, headers, t0);
      upstreamReq.end(nextBody);
    } catch (err) {
      writeCorsHeaders(clientReq, clientRes);
      writeJson(clientRes, 400, {
        error: { message: `invalid JSON body: ${err.message}`, code: "invalid_request" },
      });
    }
  });
  clientReq.on("error", (err) => {
    writeCorsHeaders(clientReq, clientRes);
    writeJson(clientRes, 400, {
      error: { message: `request read error: ${err.message}`, code: "invalid_request" },
    });
  });
}

function serveStatic(req, res, pathname) {
  const resolvedPath = resolveStaticPath(pathname);
  if (!resolvedPath) {
    writeJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  fs.stat(resolvedPath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      writeJson(res, 404, { error: { message: "Not found" } });
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      "Content-Type": contentType,
      "Content-Length": stats.size,
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(resolvedPath).pipe(res);
  });
}

function resolveStaticPath(pathname) {
  const requested = pathname === "/" ? `/${ENTRY_FILE}` : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const absolutePath = path.join(PUBLIC_DIR, safePath);

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return absolutePath;
}

function sanitizeResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (key.toLowerCase() === "content-length" || key.toLowerCase() === "content-type") {
      out[key] = value;
      continue;
    }
    if (key.toLowerCase() === "transfer-encoding") {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function createUpstreamRequest(clientReq, clientRes, target, headers, t0) {
  const upstreamReq = https.request(
    {
      hostname: target.hostname,
      port: 443,
      path: target.pathname + target.search,
      method: clientReq.method,
      headers,
    },
    (upstreamRes) => {
      writeCorsHeaders(clientReq, clientRes);
      const outHeaders = sanitizeResponseHeaders(upstreamRes.headers);
      clientRes.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(clientRes);
      upstreamRes.on("end", () => {
        console.log(
          `[${new Date().toISOString()}] ${clientReq.method} ${clientReq.url} -> ${upstreamRes.statusCode} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
      });
    }
  );

  upstreamReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error(`upstream timeout ${REQUEST_TIMEOUT_MS}ms`));
  });

  upstreamReq.on("error", (err) => {
    console.error(
      `[${new Date().toISOString()}] ${clientReq.method} ${clientReq.url} x ${err.message} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    if (!clientRes.headersSent) {
      writeCorsHeaders(clientReq, clientRes);
      writeJson(clientRes, 502, {
        error: { message: `proxy upstream error: ${err.message}`, code: "upstream_error" },
      });
    } else {
      clientRes.end();
    }
  });

  return upstreamReq;
}

function shouldOverrideImageModel(pathname, req) {
  const isImageJsonEndpoint =
    pathname === "/v1/images/generations" || pathname === "/v1/images/edits";
  return isImageJsonEndpoint &&
    req.method === "POST" &&
    req.headers["content-type"] &&
    req.headers["content-type"].includes("application/json");
}

function writeCorsHeaders(req, res) {
  if (!ALLOWED_ORIGIN) {
    return;
  }

  const requestOrigin = req.headers.origin || "";
  const allowOrigin = requestOrigin && requestOrigin === ALLOWED_ORIGIN ? requestOrigin : ALLOWED_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}
