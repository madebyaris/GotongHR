import assert from "node:assert/strict";
import test from "node:test";
import { expiryError, hashToken, randomToken, signInvite, verifyInvite } from "./tokens.ts";

test("a grant token is stored as a sha-256 hash", () => {
  const token = randomToken();
  const hash = hashToken(token);
  assert.equal(hash.length, 64);
  assert.equal(hash, hashToken(token));
  assert.notEqual(hash, token);
  assert.equal(hash.includes(token), false);
  assert.equal(
    hashToken("gotonghr"),
    "64e3c260d3db19819a77df20454d47560aec5f77e085841f02dc1d452c7221a3",
  );
});

test("grant expiry is in the future and at most four hours", () => {
  const now = new Date("2026-11-25T00:00:00.000Z");
  assert.equal(expiryError(new Date("2026-11-24T23:00:00.000Z"), now), "past");
  assert.equal(expiryError(now, now), "past");
  assert.equal(expiryError(new Date("2026-11-25T04:00:00.000Z"), now), null);
  assert.equal(expiryError(new Date("2026-11-25T04:00:00.001Z"), now), "too_long");
  assert.equal(expiryError(new Date("not-a-date"), now), "past");
  assert.equal(expiryError(new Date(Number.NaN), now), "past");
});

test("an invite token verifies once and then expires", () => {
  const secret = "gotonghr-test-auth-secret-0123456789abcdef";
  const token = signInvite(secret, {
    tenantId: "0192a7a0-0000-7000-8000-000000000001",
    email: "owner@gotonghr.test",
    exp: 2_000,
  });
  assert.deepEqual(verifyInvite(secret, token, 1_000), {
    tenantId: "0192a7a0-0000-7000-8000-000000000001",
    email: "owner@gotonghr.test",
    exp: 2_000,
  });
  assert.equal(verifyInvite(secret, token, 2_000), null);
  assert.equal(verifyInvite("other-secret-0123456789abcdefEXTRA", token, 1_000), null);
  assert.equal(hashToken(token) === token, false);
});
