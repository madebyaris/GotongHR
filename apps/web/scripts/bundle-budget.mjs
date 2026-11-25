import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");
const ESS_CAP = 120 * 1024;
const ADMIN_CAP = 180 * 1024;

function brotliSize(file) {
  const compressed = brotliCompressSync(readFileSync(file), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  return compressed.length;
}

function readManifest() {
  const candidates = [
    path.join(dist, ".vite", "manifest.json"),
    path.join(dist, "manifest.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8"));
    }
  }
  throw new Error("Vite manifest was not found. Enable build.manifest.");
}

function walk(manifest, key, files, seen) {
  if (!key || seen.has(key)) return;
  const item = manifest[key];
  if (!item) return;
  seen.add(key);
  if (typeof item.file === "string") files.add(item.file);
  for (const css of item.css ?? []) files.add(css);
  for (const child of item.imports ?? []) walk(manifest, child, files, seen);
}

function shellBytes(manifest, routeHint) {
  const entry = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
  if (!entry) throw new Error("Manifest has no entry.");
  const routeKey = Object.keys(manifest).find((key) => key.includes(routeHint));
  if (!routeKey) throw new Error(`Manifest has no ${routeHint} chunk.`);
  const files = new Set();
  walk(manifest, entry, files, new Set());
  walk(manifest, routeKey, files, new Set());
  let total = brotliSize(path.join(dist, "index.html"));
  for (const file of files) total += brotliSize(path.join(dist, file));
  return total;
}

function readDotenv(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const manifest = readManifest();
const fileMode = {
  ...readDotenv(path.join(appRoot, ".env")),
  ...readDotenv(path.join(appRoot, ".env.local")),
  ...readDotenv(path.join(appRoot, ".env.production")),
  ...readDotenv(path.join(appRoot, ".env.production.local")),
}.VITE_DEPLOYMENT_MODE;
const mode = process.env.VITE_DEPLOYMENT_MODE ?? fileMode ?? "single_tenant";
const multiTenant = mode === "multi_tenant_saas" || mode === "holding_multi_tenant";
if (!multiTenant) {
  const platform = Object.keys(manifest).filter((key) => key.includes("routes/platform"));
  if (platform.length > 0) {
    console.error(`build mode ${mode} includes the platform route: ${platform.join(", ")}`);
    process.exit(1);
  }
}

const ess = shellBytes(manifest, "routes/ess");
const admin = shellBytes(manifest, "routes/admin");
console.log(`ess brotli ${ess} bytes (cap ${ESS_CAP})`);
console.log(`admin brotli ${admin} bytes (cap ${ADMIN_CAP})`);
if (ess > ESS_CAP || admin > ADMIN_CAP) {
  process.exit(1);
}

const headersFile = path.join(dist, "_headers");
if (!existsSync(headersFile)) {
  console.error("dist/_headers is missing. Cloudflare asset headers will not deploy.");
  process.exit(1);
}
const headersText = readFileSync(headersFile, "utf8");
if (!headersText.includes("public, max-age=31536000, immutable")) {
  console.error("dist/_headers does not set immutable caching on hashed assets.");
  process.exit(1);
}
if (!headersText.includes("private, no-store")) {
  console.error("dist/_headers does not keep /api and /auth uncached.");
  process.exit(1);
}
