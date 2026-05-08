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

const GRSAI_API_KEY = process.env.GRSAI_API_KEY || "";
const GRSAI_HOST = new URL(process.env.GRSAI_HOST || "https://grsaiapi.com");
const GRSAI_MODEL = process.env.GRSAI_MODEL || "gpt-image-2";
const FALLBACK_TRIGGER_CODES = new Set([
  "NO_GATEWAY_AVAILABLE",
  "MODEL_ACCESS_DENIED",
  "upstream_error",
  "service_unavailable",
  "timeout",
  "upstream_timeout",
]);

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
  console.log(`[server] grsai fallback: ${GRSAI_API_KEY ? `enabled (${GRSAI_HOST.origin}, model=${GRSAI_MODEL})` : "disabled (set GRSAI_API_KEY to enable)"}`);
});

function proxyApiRequest(clientReq, clientRes, pathname) {
  const t0 = Date.now();
  const upstreamPath = pathname === "/api/upload"
    ? "/api/v1/upload"
    : pathname.replace(API_PREFIX, API_VERSION_PREFIX);
  const target = new URL(upstreamPath + (new URL(clientReq.url, "http://localhost").search || ""), UPSTREAM);
  const overrideModel = shouldOverrideImageModel(target.pathname, clientReq);
  const fallbackEnabled = !!GRSAI_API_KEY
    && target.pathname === "/v1/images/generations"
    && clientReq.method === "POST"
    && (clientReq.headers["content-type"] || "").includes("application/json");

  const headers = {
    "authorization": `Bearer ${API_KEY}`,
    "content-type": clientReq.headers["content-type"] || "application/json",
  };
  if (clientReq.headers["user-agent"]) {
    headers["user-agent"] = clientReq.headers["user-agent"];
  }

  if (!overrideModel && !fallbackEnabled) {
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
    let payload;
    try {
      const originalBody = Buffer.concat(chunks).toString("utf8");
      payload = JSON.parse(originalBody || "{}");
    } catch (err) {
      writeCorsHeaders(clientReq, clientRes);
      writeJson(clientRes, 400, {
        error: { message: `invalid JSON body: ${err.message}`, code: "invalid_request" },
      });
      return;
    }
    if (overrideModel) payload.model = IMAGE_MODEL;
    const upstreamBody = JSON.stringify(payload);
    headers["content-length"] = Buffer.byteLength(upstreamBody);

    if (!fallbackEnabled) {
      const upstreamReq = createUpstreamRequest(clientReq, clientRes, target, headers, t0);
      upstreamReq.end(upstreamBody);
      return;
    }

    callPicklyoneBuffered(target, headers, upstreamBody)
      .then((result) => {
        if (shouldFallbackToGrsai(result)) {
          logUpstreamError(clientReq, result, t0);
          return callGrsai(payload).then((fallbackJson) => {
            writeCorsHeaders(clientReq, clientRes);
            writeJson(clientRes, 200, fallbackJson);
            console.log(
              `[${new Date().toISOString()}] ${clientReq.method} ${clientReq.url} -> 200 (fallback=grsai) · ${((Date.now() - t0) / 1000).toFixed(1)}s`
            );
          }).catch((grsaiErr) => {
            console.error(
              `[${new Date().toISOString()}] grsai fallback failed: ${grsaiErr.message}`
            );
            forwardBufferedResult(clientReq, clientRes, result, t0);
          });
        }
        forwardBufferedResult(clientReq, clientRes, result, t0);
      })
      .catch((err) => {
        console.error(
          `[${new Date().toISOString()}] picklyone network error: ${err.message}`
        );
        callGrsai(payload)
          .then((fallbackJson) => {
            writeCorsHeaders(clientReq, clientRes);
            writeJson(clientRes, 200, fallbackJson);
            console.log(
              `[${new Date().toISOString()}] ${clientReq.method} ${clientReq.url} -> 200 (fallback=grsai after network err) · ${((Date.now() - t0) / 1000).toFixed(1)}s`
            );
          })
          .catch((grsaiErr) => {
            console.error(
              `[${new Date().toISOString()}] grsai fallback failed: ${grsaiErr.message}`
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
      });
  });
  clientReq.on("error", (err) => {
    writeCorsHeaders(clientReq, clientRes);
    writeJson(clientRes, 400, {
      error: { message: `request read error: ${err.message}`, code: "invalid_request" },
    });
  });
}

function callPicklyoneBuffered(target, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: "POST",
        headers,
      },
      (res) => {
        const bodyChunks = [];
        res.on("data", (c) => bodyChunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 502,
            headers: res.headers,
            body: Buffer.concat(bodyChunks),
          });
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`upstream timeout ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function shouldFallbackToGrsai(result) {
  if (!result || !result.statusCode) return true;
  if (result.statusCode >= 500) return true;
  if (result.statusCode === 408 || result.statusCode === 429) return true;
  let parsed;
  try {
    parsed = JSON.parse(result.body.toString("utf8"));
  } catch (_) {
    return false;
  }
  const code = parsed?.error?.code || parsed?.code || "";
  return FALLBACK_TRIGGER_CODES.has(code);
}

function forwardBufferedResult(clientReq, clientRes, result, t0) {
  writeCorsHeaders(clientReq, clientRes);
  const outHeaders = sanitizeResponseHeaders(result.headers);
  outHeaders["content-length"] = result.body.length;
  clientRes.writeHead(result.statusCode, outHeaders);
  clientRes.end(result.body);
  console.log(
    `[${new Date().toISOString()}] ${clientReq.method} ${clientReq.url} -> ${result.statusCode} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
}

function logUpstreamError(clientReq, result, t0) {
  let reason = `HTTP ${result.statusCode}`;
  try {
    const parsed = JSON.parse(result.body.toString("utf8"));
    reason += ` ${parsed?.error?.code || parsed?.code || ""}`.trim();
  } catch (_) {}
  console.log(
    `[${new Date().toISOString()}] picklyone failed (${reason}) · ${((Date.now() - t0) / 1000).toFixed(1)}s — trying grsai`
  );
}

function callGrsai(payload) {
  return new Promise((resolve, reject) => {
    const grsaiBody = JSON.stringify({
      model: GRSAI_MODEL,
      prompt: payload.prompt,
      size: normalizeGrsaiSize(payload.size),
      n: clamp(parseInt(payload.n, 10) || 1, 1, 4),
    });
    const req = https.request(
      {
        hostname: GRSAI_HOST.hostname,
        port: GRSAI_HOST.port || 443,
        path: "/v1/draw/completions",
        method: "POST",
        headers: {
          "authorization": `Bearer ${GRSAI_API_KEY}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(grsaiBody),
          "accept": "text/event-stream",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const errChunks = [];
          res.on("data", (c) => errChunks.push(c));
          res.on("end", () => {
            reject(new Error(`grsai HTTP ${res.statusCode}: ${Buffer.concat(errChunks).toString("utf8").slice(0, 400)}`));
          });
          res.on("error", reject);
          return;
        }
        let buffer = "";
        let lastEvent = null;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                lastEvent = JSON.parse(line.slice(5).trim());
              } catch (_) {}
            }
          }
        });
        res.on("end", () => {
          if (!lastEvent) return reject(new Error("grsai returned no events"));
          if (lastEvent.status === "succeeded" && Array.isArray(lastEvent.results) && lastEvent.results.length) {
            resolve({
              created: Math.floor(Date.now() / 1000),
              data: lastEvent.results
                .filter((r) => r && r.url)
                .map((r) => ({ url: r.url })),
            });
            return;
          }
          const reason = lastEvent.failure_reason || lastEvent.error || `grsai status: ${lastEvent.status}`;
          reject(new Error(reason));
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`grsai timeout ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.end(grsaiBody);
  });
}

function normalizeGrsaiSize(size) {
  if (!size || size === "auto") return "1024x1024";
  return size;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
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
