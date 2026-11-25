import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("idle entrypoints", () => {
  for (const role of ["attendance", "worker", "ai"] as const) {
    it(`logs ${role} and exits 0`, () => {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", path.join(here, "entrypoints", `${role}.ts`)],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`"role":"${role}"`));
    });
  }
});
