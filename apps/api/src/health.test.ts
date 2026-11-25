import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildServer } from "./server.ts";

describe("health routes", () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  after(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it("answers healthz without a database", async () => {
    const app = await buildServer({
      checkReady: async () => {
        throw new Error("database");
      },
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      data: { status: "ok" },
      meta: null,
      error: null,
    });
  });

  it("trusts one forwarded hop by default", async () => {
    const app = await buildServer({ checkReady: async () => {} });
    apps.push(app);
    app.get("/who", async (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/who",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ip, "203.0.113.9");
  });

  it("returns 503 from readyz when the check fails and 200 when it passes", async () => {
    const down = await buildServer({
      checkReady: async () => {
        throw new Error("database");
      },
    });
    apps.push(down);
    const notReady = await down.inject({ method: "GET", url: "/readyz" });
    assert.equal(notReady.statusCode, 503);
    assert.equal(notReady.json().error.code, "not_ready");

    const up = await buildServer({ checkReady: async () => {} });
    apps.push(up);
    const ready = await up.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), {
      data: { status: "ready" },
      meta: null,
      error: null,
    });
  });
});
