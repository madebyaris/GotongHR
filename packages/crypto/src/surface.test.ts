import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "./index.ts";

test("the crypto barrel does not export decryptField", () => {
  assert.equal("decryptField" in crypto, false);
  assert.equal(typeof crypto.encryptField, "function");
  assert.equal(typeof crypto.maskNik, "function");
  assert.equal(typeof crypto.blindIndex, "function");
});
