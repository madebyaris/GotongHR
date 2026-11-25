import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { clientAddress, isCredentialRoute, rateLimitKey } from "./rate-limit.ts";

test("two-factor verification routes are rate limited", () => {
  for (const path of [
    "/api/auth/sign-in/email",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/two-factor/verify-totp",
    "/api/auth/two-factor/verify-backup-code",
    "/api/auth/two-factor/send-otp",
    "/api/auth/two-factor/verify-otp",
  ]) {
    assert.equal(isCredentialRoute(`${path}?next=1`), true, path);
  }
  assert.equal(isCredentialRoute("/api/auth/two-factor/enable"), false);
  assert.equal(isCredentialRoute("/healthz"), false);
});

test("a spoofed Cloudflare header is ignored unless the operator opts in", () => {
  const request = {
    ip: "10.0.0.8",
    url: "/api/auth/sign-in/email",
    headers: { "cf-connecting-ip": "203.0.113.9" },
  } as unknown as FastifyRequest;
  assert.equal(clientAddress(request, false), "10.0.0.8");
  assert.equal(rateLimitKey(request, false), "10.0.0.8:/api/auth/sign-in/email");
  assert.equal(clientAddress(request, true), "203.0.113.9");
  assert.equal(rateLimitKey(request, true), "203.0.113.9:/api/auth/sign-in/email");
});
