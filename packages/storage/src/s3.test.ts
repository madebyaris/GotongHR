import assert from "node:assert/strict";
import test from "node:test";
import { createS3Storage } from "./s3.ts";

test("s3 presignPut returns a signed PUT url without calling the network", async () => {
  const storage = createS3Storage({
    bucket: "gotonghr-test",
    region: "ap-southeast-3",
    endpoint: "https://s3.example.test",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secretsecretsecret" },
  });
  const signed = await storage.presignPut({
    key: "tenant/a.webp",
    contentType: "image/webp",
    maxBytes: 100_000,
  });
  assert.equal(signed.method, "PUT");
  assert.match(signed.url, /gotonghr-test/);
  assert.match(signed.url, /tenant/);
  assert.equal(signed.headers["content-type"], "image/webp");

  const read = await storage.presignGet({ key: "tenant/a.webp" });
  assert.equal(read.method, "GET");
  assert.match(read.url, /tenant/);
});
