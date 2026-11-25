import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");
const ESS_CAP = 120 * 1024;
const ADMIN_CAP = 180 * 1024;
const PLATFORM_MARKER = "data-gotong-platform-console";

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

function routeKeyFor(manifest, routeHint) {
  const keys = Object.keys(manifest).filter((key) => key.includes(routeHint));
  const index = keys.find((key) => key.includes(`${routeHint}/index`));
  return index ?? keys[0];
}

function shellBytes(manifest, routeHint) {
  const entry = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
  if (!entry) throw new Error("Manifest has no entry.");
  const routeKey = routeKeyFor(manifest, routeHint);
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

export function platformMarkerHits(dir) {
  return jsFiles(dir).filter((file) => readFileSync(file, "utf8").includes(PLATFORM_MARKER));
}

function jsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function main() {
  const manifest = readManifest();
  const fileMode = {
    ...readDotenv(path.join(appRoot, ".env")),
    ...readDotenv(path.join(appRoot, ".env.local")),
    ...readDotenv(path.join(appRoot, ".env.production")),
    ...readDotenv(path.join(appRoot, ".env.production.local")),
  }.VITE_DEPLOYMENT_MODE;
  const mode = process.env.VITE_DEPLOYMENT_MODE ?? fileMode ?? "single_tenant";
  const multiTenant = mode === "multi_tenant_saas" || mode === "holding_multi_tenant";
  const markerHits = platformMarkerHits(dist);
  if (!multiTenant) {
    const platform = Object.keys(manifest).filter((key) => key.includes("routes/platform"));
    if (platform.length > 0) {
      console.error(`build mode ${mode} includes the platform route: ${platform.join(", ")}`);
      process.exit(1);
    }
    if (markerHits.length > 0) {
      console.error(`build mode ${mode} includes the platform marker: ${markerHits.join(", ")}`);
      process.exit(1);
    }
  } else if (markerHits.length === 0) {
    console.error(`build mode ${mode} is missing the platform marker`);
    process.exit(1);
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
  const privatePaths = ["/api", "/api/auth/sign-in", "/auth", "/auth/sign-in"];
  for (const pathname of privatePaths) {
    if (cacheControlFor(headersText, pathname) !== "private, no-store") {
      console.error(`dist/_headers does not keep ${pathname} uncached.`);
      process.exit(1);
    }
  }
  if (cacheControlFor(headersText, "/assets/app-abc123.js") !== "public, max-age=31536000, immutable") {
    console.error("dist/_headers does not set immutable caching on hashed assets.");
    process.exit(1);
  }
}

function cacheControlFor(fileText, pathname) {
  const headers = new Map();
  let pattern = "";
  for (const rawLine of fileText.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
      pattern = line;
      continue;
    }
    if (!headerPathMatches(pattern, pathname)) continue;
    if (line.startsWith("! ")) {
      headers.delete(line.slice(2).trim().toLowerCase());
      continue;
    }
    const splitAt = line.indexOf(":");
    if (splitAt <= 0) {
      console.error(`dist/_headers has a bad line: ${line}`);
      process.exit(1);
    }
    const name = line.slice(0, splitAt).trim().toLowerCase();
    const value = line.slice(splitAt + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
  }
  return headers.get("cache-control");
}

function headerPathMatches(pattern, pathname) {
  if (!pattern.includes("*")) return pattern === pathname;
  const star = pattern.indexOf("*");
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    pathname.startsWith(prefix) &&
    pathname.endsWith(suffix) &&
    pathname.length >= prefix.length + suffix.length
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
