import assert from "node:assert/strict";
import test from "node:test";
import { PRIVATE_NO_STORE, SECURITY_HEADERS } from "./headers.ts";
import { handleRequest, type WorkerEnv } from "./index.ts";

const ASSETS: WorkerEnv["ASSETS"] = {
  fetch: () => Promise.reject(new Error("ASSETS binding should not be used directly")),
};

function env(partial: Omit<WorkerEnv, "ASSETS">): WorkerEnv {
  return { ASSETS, ...partial };
}

test("proxy forwards /api to API_ORIGIN and strips a spoofed X-Forwarded-For", async () => {
  let seenUrl = "";
  let seen: Headers | undefined;
  const response = await handleRequest(
    new Request("https://hr.example.co.id/api/readyz?probe=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "better-auth.session_token=abc",
        origin: "https://hr.example.co.id",
        "x-forwarded-for": "1.2.3.4, 10.0.0.8",
        "x-real-ip": "1.2.3.4",
        forwarded: "for=1.2.3.4",
        "true-client-ip": "1.2.3.4",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ ok: true }),
    }),
    env({ API_ORIGIN: "https://origin.example.co.id", ENVIRONMENT: "production" }),
    {
      assets: () => Promise.reject(new Error("assets")),
      upstream: (input, init) => {
        seenUrl = input;
        seen = new Headers(init.headers);
        return Promise.resolve(
          new Response('{"data":{"status":"ready"}}', {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=3600",
            },
          }),
        );
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), PRIVATE_NO_STORE);
  assert.equal(seenUrl, "https://origin.example.co.id/readyz?probe=1");
  assert.equal(seen?.get("x-forwarded-for"), "203.0.113.10");
  assert.equal(seen?.get("cf-connecting-ip"), "203.0.113.10");
  assert.equal(seen?.get("x-real-ip"), null);
  assert.equal(seen?.get("forwarded"), null);
  assert.equal(seen?.get("true-client-ip"), null);
  assert.equal(seen?.get("cookie"), "better-auth.session_token=abc");
  assert.equal(seen?.get("origin"), "https://hr.example.co.id");
  assert.equal(seen?.get("x-forwarded-host"), "hr.example.co.id");
  assert.equal(seen?.get("x-forwarded-proto"), "https");
  assert.equal(seen?.get("x-forwarded-for")?.includes("1.2.3.4"), false);
});

test("a missing or non-HTTPS API_ORIGIN is not proxied in production", async () => {
  let calls = 0;
  const upstream = () => {
    calls += 1;
    return Promise.resolve(new Response("no"));
  };
  const missing = await handleRequest(
    new Request("https://hr.example.co.id/api/auth/sign-in"),
    env({ ENVIRONMENT: "production" }),
    { assets: () => Promise.reject(new Error("assets")), upstream },
  );
  const insecure = await handleRequest(
    new Request("https://hr.example.co.id/api/auth/sign-in"),
    env({ API_ORIGIN: "http://origin.example.co.id", ENVIRONMENT: "production" }),
    { assets: () => Promise.reject(new Error("assets")), upstream },
  );
  const pathed = await handleRequest(
    new Request("https://hr.example.co.id/api/readyz"),
    env({ API_ORIGIN: "https://origin.example.co.id/internal", ENVIRONMENT: "production" }),
    { assets: () => Promise.reject(new Error("assets")), upstream },
  );

  assert.equal(missing.status, 502);
  assert.equal(insecure.status, 502);
  assert.equal(pathed.status, 502);
  assert.equal(missing.headers.get("cache-control"), PRIVATE_NO_STORE);
  assert.equal(calls, 0);
  const body = (await missing.json()) as { error: { code: string } };
  assert.equal(body.error.code, "bad_gateway");
});

test("development may proxy to an http loopback origin", async () => {
  let seenUrl = "";
  const response = await handleRequest(
    new Request("http://localhost:8787/api/healthz"),
    env({ API_ORIGIN: "http://127.0.0.1:3000", ENVIRONMENT: "development" }),
    {
      assets: () => Promise.reject(new Error("assets")),
      upstream: (input) => {
        seenUrl = input;
        return Promise.resolve(new Response("ok"));
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(seenUrl, "http://127.0.0.1:3000/healthz");
  assert.equal(response.headers.get("cache-control"), PRIVATE_NO_STORE);
});

test("a spoofed client IP chain is not forwarded when CF-Connecting-IP is not a single IP", async () => {
  let seen: Headers | undefined;
  await handleRequest(
    new Request("https://hr.example.co.id/api/readyz", {
      headers: {
        "cf-connecting-ip": "203.0.113.10, 198.51.100.4",
        "x-forwarded-for": "1.2.3.4",
      },
    }),
    env({ API_ORIGIN: "https://origin.example.co.id", ENVIRONMENT: "production" }),
    {
      assets: () => Promise.reject(new Error("assets")),
      upstream: (_input, init) => {
        seen = new Headers(init.headers);
        return Promise.resolve(new Response("ok"));
      },
    },
  );
  assert.equal(seen?.get("x-forwarded-for"), null);
  assert.equal(seen?.get("cf-connecting-ip"), null);
});

test("/api and /auth responses are private and not stored", async () => {
  const api = await handleRequest(
    new Request("https://hr.example.co.id/api/attendance/clock"),
    env({ API_ORIGIN: "https://origin.example.co.id", ENVIRONMENT: "production" }),
    {
      assets: () => Promise.reject(new Error("assets")),
      upstream: () => Promise.resolve(new Response("{}", { headers: { "cache-control": "public, max-age=60" } })),
    },
  );
  const auth = await handleRequest(
    new Request("https://hr.example.co.id/auth/sign-in"),
    env({ ENVIRONMENT: "production" }),
    {
      assets: () => Promise.resolve(new Response("<html></html>", { headers: { "content-type": "text/html" } })),
    },
  );
  assert.equal(api.headers.get("cache-control"), PRIVATE_NO_STORE);
  assert.equal(auth.headers.get("cache-control"), PRIVATE_NO_STORE);
  assert.equal(auth.headers.get("x-content-type-options"), "nosniff");
});

test("HTML responses from ASSETS get the security headers", async () => {
  let assetCalls = 0;
  const response = await handleRequest(
    new Request("https://hr.example.co.id/ess"),
    env({ ENVIRONMENT: "production" }),
    {
      assets: (request) => {
        assetCalls += 1;
        assert.equal(new URL(request.url).pathname, "/ess");
        return Promise.resolve(
          new Response("<html></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      },
    },
  );
  assert.equal(assetCalls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value);
  }
  assert.equal(await response.text(), "<html></html>");
});

test("hashed assets pass through ASSETS without a Worker cache override", async () => {
  const response = await handleRequest(
    new Request("https://hr.example.co.id/assets/app-abc123.js"),
    env({ ENVIRONMENT: "production" }),
    {
      assets: () =>
        Promise.resolve(
          new Response("export {}", {
            headers: {
              "content-type": "text/javascript",
              "cache-control": "public, max-age=31536000, immutable",
            },
          }),
        ),
    },
  );
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(await response.text(), "export {}");
});

test("a disallowed method is refused before the origin is called", async () => {
  let calls = 0;
  const response = await handleRequest(
    new Request("https://hr.example.co.id/api/readyz", { method: "PROPFIND" }),
    env({ API_ORIGIN: "https://origin.example.co.id", ENVIRONMENT: "production" }),
    {
      assets: () => Promise.reject(new Error("assets")),
      upstream: () => {
        calls += 1;
        return Promise.resolve(new Response("no"));
      },
    },
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("cache-control"), PRIVATE_NO_STORE);
  assert.equal(calls, 0);
});

test("an upstream redirect is returned to the browser", async () => {
  const response = await handleRequest(
    new Request("https://hr.example.co.id/api/auth/sign-in", { method: "POST", body: "{}" }),
    env({ API_ORIGIN: "https://origin.example.co.id", ENVIRONMENT: "production" }),
    {
      assets: () => Promise.reject(new Error("assets")),
      upstream: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://hr.example.co.id/ess" },
          }),
        ),
    },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://hr.example.co.id/ess");
});

test("a body over 2 MB is refused", async () => {
  let calls = 0;
  const response = await handleRequest(
    new Request("https://hr.example.co.id/api/readyz", {
      method: "POST",
      body: "x".repeat(2 * 1024 * 1024 + 1),
    }),
    env({ API_ORIGIN: "https://origin.example.co.id", ENVIRONMENT: "production" }),
    {
      assets: () => Promise.reject(new Error("assets")),
      upstream: () => {
        calls += 1;
        return Promise.resolve(new Response("no"));
      },
    },
  );
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});
