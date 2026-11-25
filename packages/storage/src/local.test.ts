import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

    const opened = storage.stat({ key: "tenant/a.txt" });
    assert.equal((await opened)?.byteSize, Buffer.byteLength("hello"));
    let streamed = "";
    for await (const chunk of await storage.openRead({ key: "tenant/a.txt" })) {
      streamed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    }
    assert.equal(streamed, "hello");

    await storage.delete({ key: "tenant/a.txt" });
    await assert.rejects(stat(path.join(root, "tenant/a.txt")));
    assert.equal(await storage.stat({ key: "tenant/a.txt" }), null);
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

  it("removes staged partials and leaves object keys alone", async () => {
    const directory = path.join(root, "tenant");
    const staging = path.join(root, ".upload-partials");
    await mkdir(directory, { recursive: true });
    await mkdir(staging, { recursive: true });
    const kept = path.join(directory, "kept.txt");
    const keyShaped = path.join(directory, "kept.txt.abcdabcdabcdabcdabcdabcdabcdabcd.partial");
    const namedPartial = path.join(directory, "notes.partial");
    const staged = path.join(staging, `${"ab".repeat(16)}.partial`);
    await writeFile(kept, "kept");
    await writeFile(keyShaped, "user-data");
    await writeFile(namedPartial, "keep-me");
    await writeFile(staged, "orphan");
    const storage = createLocalStorage({ rootDir: root, secret: "test-secret", urlPrefix: "" });
    const app = Fastify({ logger: false });
    await storage.registerRoutes(app);
    await assert.rejects(stat(staged));
    assert.equal(await readFile(kept, "utf8"), "kept");
    assert.equal(await readFile(keyShaped, "utf8"), "user-data");
    assert.equal(await readFile(namedPartial, "utf8"), "keep-me");
    await app.close();
  });

  it("refuses to upload through a symlinked staging directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gotong-staging-"));
    const outside = await mkdtemp(path.join(tmpdir(), "gotong-outside-"));
    try {
      await symlink(outside, path.join(directory, ".upload-partials"));
      const storage = createLocalStorage({ rootDir: directory, secret: "test-secret", urlPrefix: "" });
      const app = Fastify({ logger: false });
      await storage.registerRoutes(app);
      const signed = await storage.presignPut({
        key: "tenant/linked.txt",
        contentType: "text/plain",
        maxBytes: 20,
      });
      const put = await app.inject({
        method: "PUT",
        url: signed.url,
        payload: Buffer.from("secret-bytes"),
      });
      assert.equal(put.statusCode, 500);
      await assert.rejects(stat(path.join(directory, "tenant/linked.txt")));
      assert.deepEqual(await readdir(outside), []);
      await app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("registers routes when the partial sweep cannot read staging", async () => {
    const blocked = path.join(root, "not-a-directory");
    await writeFile(blocked, "x");
    const storage = createLocalStorage({ rootDir: blocked, secret: "test-secret", urlPrefix: "" });
    const app = Fastify({ logger: false });
    await storage.registerRoutes(app);
    const health = await app.inject({ method: "GET", url: "/storage/local/objects" });
    assert.equal(health.statusCode, 403);
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
