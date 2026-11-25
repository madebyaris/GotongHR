import assert from "node:assert/strict";
import test from "node:test";
import {
  readAuthBaseUrl,
  readAuthRateLimit,
  readBootstrapInput,
  readTrustCloudflare,
  readTrustProxy,
  readTrustedOrigins,
} from "./env.ts";

const production = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "production-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "https://hr.example.com",
  GOTONG_BOOTSTRAP_EMAIL: "owner@example.com",
  GOTONG_BOOTSTRAP_PASSWORD: "owner-password-1",
};

test("production requires an https auth url and merges extra origins", () => {
  assert.throws(() => readAuthBaseUrl({ NODE_ENV: "production" }), /Missing BETTER_AUTH_URL/);
  assert.throws(
    () => readAuthBaseUrl({ NODE_ENV: "production", BETTER_AUTH_URL: "http://hr.example.com" }),
    /https/,
  );
  assert.deepEqual(readTrustedOrigins(production), ["https://hr.example.com"]);
  assert.deepEqual(
    readTrustedOrigins({
      ...production,
      GOTONG_TRUSTED_ORIGINS: "https://app.example.com, https://hr.example.com/",
    }),
    ["https://hr.example.com", "https://app.example.com"],
  );
  assert.throws(
    () => readTrustedOrigins({ ...production, GOTONG_TRUSTED_ORIGINS: "http://localhost" }),
    /https/,
  );
});

test("bootstrap rejects a password longer than 128 characters before a write", () => {
  assert.throws(
    () =>
      readBootstrapInput({
        ...production,
        GOTONG_BOOTSTRAP_PASSWORD: "x".repeat(129),
      }),
    /12 to 128/,
  );
});

test("rate limit values stay inside a postgres integer", () => {
  assert.throws(
    () => readAuthRateLimit({ GOTONG_AUTH_RATE_LIMIT_WINDOW_MS: "2147483648" }),
    /invalid/i,
  );
  assert.deepEqual(readAuthRateLimit({}), { max: 10, windowMs: 60_000 });
});

test("proxy trust defaults to one hop and cloudflare stays off", () => {
  assert.equal(readTrustProxy({}), 1);
  assert.equal(readTrustProxy({ GOTONG_TRUST_PROXY: "" }), 1);
  assert.equal(readTrustProxy({ GOTONG_TRUST_PROXY: "   " }), 1);
  assert.equal(readTrustProxy({ GOTONG_TRUST_PROXY: "false" }), false);
  assert.throws(() => readTrustProxy({ GOTONG_TRUST_PROXY: "true" }), /hop count/);
  assert.deepEqual(readTrustProxy({ GOTONG_TRUST_PROXY: "10.0.0.1, 10.0.0.2" }), [
    "10.0.0.1",
    "10.0.0.2",
  ]);
  assert.equal(readTrustProxy({ GOTONG_TRUST_PROXY: "203.0.113.0/24" }), "203.0.113.0/24");
  assert.throws(() => readTrustProxy({ GOTONG_TRUST_PROXY: "not-an-address" }), /invalid/i);
  assert.throws(() => readTrustProxy({ GOTONG_TRUST_PROXY: "10.0.0.1/" }), /invalid/i);
  assert.throws(() => readTrustProxy({ GOTONG_TRUST_PROXY: "fd00::/" }), /invalid/i);
  assert.throws(() => readTrustProxy({ GOTONG_TRUST_PROXY: "10.0.0.1/abc" }), /invalid/i);
  assert.equal(readTrustCloudflare({}), false);
  assert.equal(readTrustCloudflare({ GOTONG_TRUST_CLOUDFLARE: "true" }), true);
});
