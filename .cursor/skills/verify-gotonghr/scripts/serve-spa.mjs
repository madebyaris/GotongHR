/**
 * Stand-in for docker/Caddyfile when the compose daemon is not running.
 * /api/readyz is rewritten to /readyz. Every other /api path keeps its prefix.
 * A missing file falls back to index.html. This process is not Caddy.
 */
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const root = path.resolve(required("GOTONG_VERIFY_WEB_ROOT"));
const api = new URL(required("GOTONG_VERIFY_API_ORIGIN"));
const port = Number(required("PORT"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT is invalid.");
}

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/readyz") {
    proxy(request, response, "/readyz", url.search);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    proxy(request, response, url.pathname, url.search);
    return;
  }
  serveFile(url.pathname, response);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ msg: "verify spa listening", port })}\n`);
});

function proxy(request, response, pathname, search) {
  const headers = { ...request.headers, host: api.host };
  const upstream = http.request(
    api.origin + pathname + search,
    { method: request.method, headers },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) return;
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("api unavailable");
  });
  request.pipe(upstream);
}

function serveFile(pathname, response) {
  if (pathname === "/_headers" || pathname === "/_redirects" || pathname === "/.assetsignore") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const relative = spaPath(pathname);
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("bad path");
    return;
  }
  access(file)
    .then(() => send(file, response))
    .catch(() => send(path.join(root, pathname.startsWith("/ess") ? "ess/index.html" : "index.html"), response));
}

function spaPath(pathname) {
  if (pathname === "/") return "index.html";
  if (pathname === "/ess" || pathname === "/ess/") return "ess/index.html";
  return pathname.replace(/^\/+/u, "");
}

function send(file, response) {
  const type = types.get(path.extname(file)) ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type });
  createReadStream(file).on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }).pipe(response);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
