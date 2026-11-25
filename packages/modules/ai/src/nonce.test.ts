import assert from "node:assert/strict";
import test from "node:test";
import { createConfirmationNonce, hashNonce, nonceMatches } from "./nonce.ts";

test("nonceMatches accepts the secret and rejects a different one", () => {
  const created = createConfirmationNonce();
  assert.equal(created.hash, hashNonce(created.nonce));
  assert.equal(created.nonce.length >= 32, true);
  assert.equal(created.hash.length, 64);
  assert.equal(nonceMatches(created.nonce, created.hash), true);
  assert.equal(nonceMatches(`${created.nonce}x`, created.hash), false);
  assert.equal(nonceMatches("", created.hash), false);
  assert.equal(nonceMatches(created.nonce, "not-a-hash"), false);
  assert.equal(nonceMatches(created.nonce, ""), false);
});
