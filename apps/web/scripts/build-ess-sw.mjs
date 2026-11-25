import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectManifest } from "workbox-build";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

function readManifest() {
  for (const candidate of [path.join(dist, ".vite", "manifest.json"), path.join(dist, "manifest.json")]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8"));
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

const manifest = readManifest();
const entry =
  manifest["ess/index.html"]?.isEntry === true
    ? "ess/index.html"
    : Object.keys(manifest).find((key) => key.endsWith("ess/index.html") && manifest[key]?.isEntry);
if (!entry) throw new Error("ESS entry is missing from the Vite manifest.");

const files = new Set(["ess/index.html"]);
walk(manifest, entry, files, new Set());

await injectManifest({
  swSrc: path.join(appRoot, "src/ess/sw.js"),
  swDest: path.join(dist, "ess-sw.js"),
  globDirectory: dist,
  globPatterns: [...files],
  maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
});

const output = readFileSync(path.join(dist, "ess-sw.js"), "utf8");
if (!output.includes("ess/index.html") || !output.includes("ess-shifts-14d")) {
  throw new Error("ESS service worker did not precache the shell or the shift cache.");
}
if (output.includes("self.__WB_MANIFEST")) {
  throw new Error("ESS service worker still has the injection point.");
}
console.log(`ess service worker precache ${files.size} files`);
