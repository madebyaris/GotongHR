import assert from "node:assert/strict";
import test from "node:test";
import config from "../index.js";

test("the shared config is a non-empty flat config", () => {
  assert.ok(Array.isArray(config));
  assert.ok(config.length > 3);
});
