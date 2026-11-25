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

test("a spoofed Cloudflare header is ignored unless the peer is a trusted proxy", () => {
  const direct = {
    ip: "203.0.113.50",
    url: "/api/auth/sign-in/email",
    headers: { "cf-connecting-ip": "198.51.100.9" },
    socket: { remoteAddress: "203.0.113.50" },
  } as unknown as FastifyRequest;
  assert.equal(clientAddress(direct, false, 1), "203.0.113.50");
  assert.equal(clientAddress(direct, true, 1), "203.0.113.50");
  assert.equal(rateLimitKey(direct, true, 1), "203.0.113.50:/api/auth/sign-in/email");

  const proxied = {
    ip: "10.0.0.8",
    url: "/api/auth/sign-in/email",
    headers: { "cf-connecting-ip": "203.0.113.9" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as FastifyRequest;
  const other = {
    ...proxied,
    headers: { "cf-connecting-ip": "203.0.113.10" },
  } as unknown as FastifyRequest;
  assert.equal(clientAddress(proxied, true, 1), "203.0.113.9");
  assert.equal(rateLimitKey(proxied, true, 1), "203.0.113.9:/api/auth/sign-in/email");
  assert.equal(rateLimitKey(other, true, 1), "203.0.113.10:/api/auth/sign-in/email");
  assert.notEqual(rateLimitKey(proxied, true, 1), rateLimitKey(other, true, 1));
});
