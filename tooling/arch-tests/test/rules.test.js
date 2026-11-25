import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const config = require("../.dependency-cruiser.cjs");

test("architecture rules cover module boundaries", () => {
  const names = config.forbidden.map((rule) => rule.name);
  assert.deepEqual(names, [
    "no-sibling-module-imports",
    "payroll-engine-stays-pure",
    "web-does-not-import-server",
  ]);
  for (const rule of config.forbidden) {
    assert.equal(rule.severity, "error");
  }
});
