import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import Fastify from "fastify";
import { createLocalStorage } from "./local.ts";
import { createStorage } from "./index.ts";
import { MAX_UPLOAD_BYTES } from "./types.ts";

describe("local object storage", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "gotong-objects-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams a put under 2 MB and rejects a larger body", async () => {
    const storage = createLocalStorage({
      rootDir: root,
      secret: "test-secret",
      urlPrefix: "",
    });
    const app = Fastify({ logger: false });
    await storage.registerRoutes(app);

    const small = await storage.presignPut({
      key: "tenant/a.txt",
      contentType: "text/plain",
      maxBytes: MAX_UPLOAD_BYTES,
    });
    const put = await app.inject({
      method: "PUT",
      url: small.url,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("hello"),
    });
    assert.equal(put.statusCode, 200);
    assert.equal(await readFile(path.join(root, "tenant/a.txt"), "utf8"), "hello");

    const got = await storage.presignGet({ key: "tenant/a.txt" });
    const read = await app.inject({ method: "GET", url: got.url });
    assert.equal(read.statusCode, 200);
    assert.equal(read.body, "hello");

    const huge = await storage.presignPut({
      key: "tenant/big.bin",
      contentType: "application/octet-stream",
      maxBytes: MAX_UPLOAD_BYTES,
    });
    const rejected = await app.inject({
      method: "PUT",
      url: huge.url,
      headers: { "content-type": "application/octet-stream", "content-length": String(MAX_UPLOAD_BYTES + 1) },
      payload: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
    });
    assert.equal(rejected.statusCode, 413);
    await assert.rejects(stat(path.join(root, "tenant/big.bin")));

    await storage.delete({ key: "tenant/a.txt" });
    await assert.rejects(stat(path.join(root, "tenant/a.txt")));
    await app.close();
  });

  it("rejects a key that escapes the root", async () => {
    const storage = createLocalStorage({ rootDir: root, secret: "test-secret", urlPrefix: "" });
    await assert.rejects(storage.presignPut({
      key: "../secret",
      contentType: "text/plain",
      maxBytes: 10,
    }));
  });

  it("enforces the token size cap below the body limit", async () => {
    const storage = createLocalStorage({ rootDir: root, secret: "test-secret", urlPrefix: "" });
    const app = Fastify({ logger: false });
    await storage.registerRoutes(app);
    const signed = await storage.presignPut({
      key: "tenant/tiny.txt",
      contentType: "text/plain",
      maxBytes: 10,
    });
    const rejected = await app.inject({
      method: "PUT",
      url: signed.url,
      payload: Buffer.alloc(11),
    });
    assert.equal(rejected.statusCode, 413);
    assert.match(rejected.body, /too_large/);
    assert.match(rejected.body, /10 bytes/);
    await assert.rejects(stat(path.join(root, "tenant/tiny.txt")));
    await app.close();
  });

  it("rejects a bad token and a missing object", async () => {
    const secret = "test-secret";
    const storage = createLocalStorage({ rootDir: root, secret, urlPrefix: "" });
    const app = Fastify({ logger: false });
    await storage.registerRoutes(app);

    const signed = await storage.presignPut({
      key: "tenant/token.txt",
      contentType: "text/plain",
      maxBytes: 20,
    });
    const token = new URL(signed.url, "http://localhost").searchParams.get("token");
    assert.ok(token);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    const bad = await app.inject({
      method: "PUT",
      url: `/storage/local/objects?token=${encodeURIComponent(tampered)}`,
      payload: "x",
    });
    assert.equal(bad.statusCode, 403);

    const read = await storage.presignGet({ key: "tenant/token.txt" });
    const wrongMethod = await app.inject({ method: "PUT", url: read.url, payload: "x" });
    assert.equal(wrongMethod.statusCode, 403);

    const missing = await storage.presignGet({ key: "tenant/missing.txt" });
    const gone = await app.inject({ method: "GET", url: missing.url });
    assert.equal(gone.statusCode, 404);

    mock.timers.enable({ apis: ["Date"] });
    try {
      const short = await storage.presignPut({
        key: "tenant/soon.txt",
        contentType: "text/plain",
        maxBytes: 20,
        expiresInSeconds: 30,
      });
      mock.timers.tick(31_000);
      const expired = await app.inject({ method: "PUT", url: short.url, payload: "x" });
      assert.equal(expired.statusCode, 403);
      assert.match(expired.body, /expired/);
    } finally {
      mock.timers.reset();
    }

    const far = signedToken(
      { key: "tenant/far.txt", method: "PUT", exp: Math.floor(Date.now() / 1000) + 5000, maxBytes: 20 },
      secret,
    );
    const tooLong = await app.inject({
      method: "PUT",
      url: `/storage/local/objects?token=${encodeURIComponent(far)}`,
      payload: "x",
    });
    assert.equal(tooLong.statusCode, 403);

    await assert.rejects(
      storage.presignPut({
        key: "tenant/long.txt",
        contentType: "text/plain",
        maxBytes: 20,
        expiresInSeconds: 901,
      }),
      /900/,
    );
    await app.close();
  });

  it("removes leftover partial uploads when routes register", async () => {
    const directory = path.join(root, "tenant");
    await mkdir(directory, { recursive: true });
    const kept = path.join(directory, "kept.txt");
    const partial = path.join(directory, "kept.txt.abcdabcdabcdabcd.partial");
    const namedPartial = path.join(directory, "notes.partial");
    await writeFile(kept, "kept");
    await writeFile(partial, "orphan");
    await writeFile(namedPartial, "keep-me");
    const storage = createLocalStorage({ rootDir: root, secret: "test-secret", urlPrefix: "" });
    const app = Fastify({ logger: false });
    await storage.registerRoutes(app);
    await assert.rejects(stat(partial));
    assert.equal(await readFile(kept, "utf8"), "kept");
    assert.equal(await readFile(namedPartial, "utf8"), "keep-me");
    await app.close();
  });
});

function signedToken(payload: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

describe("storage configuration", () => {
  it("rejects a placeholder local secret", () => {
    assert.throws(
      () => createStorage({ STORAGE_DRIVER: "local", STORAGE_LOCAL_SECRET: "change-me" }),
      /placeholder/,
    );
    assert.throws(
      () => createStorage({ STORAGE_DRIVER: "local", STORAGE_LOCAL_SECRET: "Change-Me" }),
      /placeholder/,
    );
  });

  it("rejects a short local secret and accepts a long one", () => {
    assert.throws(
      () =>
        createStorage({
          STORAGE_DRIVER: "local",
          STORAGE_LOCAL_SECRET: "not-a-placeholder-but-short",
        }),
      /32/,
    );
    const storage = createStorage({
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_SECRET: "0123456789abcdef0123456789abcdef",
    });
    assert.equal(storage.kind, "local");
  });

  it("rejects half-set s3 credentials", () => {
    assert.throws(
      () =>
        createStorage({
          STORAGE_DRIVER: "s3",
          S3_BUCKET: "gotonghr-test",
          S3_REGION: "ap-southeast-3",
          S3_ACCESS_KEY_ID: "AKIATEST",
        }),
      /both be set/,
    );
  });
});
