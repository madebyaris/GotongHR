import assert from "node:assert/strict";
import test from "node:test";
import { createS3Storage } from "./s3.ts";

test("s3 presignPut returns a presigned POST with a content-length cap", async () => {
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
  assert.equal(signed.method, "POST");
  assert.match(signed.url, /gotonghr-test/);
  assert.equal(signed.fields?.key, "tenant/a.webp");
  assert.equal(signed.fields?.["Content-Type"], "image/webp");
  const policyField = signed.fields?.Policy ?? signed.fields?.policy;
  assert.ok(policyField);
  const policy = JSON.parse(Buffer.from(policyField, "base64").toString("utf8")) as {
    conditions?: unknown[];
  };
  const range = policy.conditions?.find(
    (item) => Array.isArray(item) && item[0] === "content-length-range",
  );
  assert.ok(Array.isArray(range));
  assert.equal(range[2], 100_000);

  const read = await storage.presignGet({ key: "tenant/a.webp" });
  assert.equal(read.method, "GET");
  assert.match(read.url, /tenant/);
});
