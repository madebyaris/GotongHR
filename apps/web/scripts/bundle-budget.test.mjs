import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { platformMarkerHits } from "./bundle-budget.mjs";

test("a single_tenant scan sees no platform marker until a platform file is added", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gotong-budget-"));
  try {
    writeFileSync(path.join(dir, "app.js"), "export const home = true;\n");
    assert.deepEqual(platformMarkerHits(dir), []);
    writeFileSync(path.join(dir, "platform.js"), 'main.setAttribute("data-gotong-platform-console", "")\n');
    const hits = platformMarkerHits(dir);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /platform\.js$/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
