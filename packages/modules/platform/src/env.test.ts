import assert from "node:assert/strict";
import test from "node:test";
import { platformApiMounted, readPlatformDatabaseUrl } from "./env.ts";

test("platform routes mount for multi-tenant modes only", () => {
  assert.equal(platformApiMounted("single_tenant"), false);
  assert.equal(platformApiMounted("multi_tenant_saas"), true);
  assert.equal(platformApiMounted("holding_multi_tenant"), true);
  assert.equal(platformApiMounted(""), false);
});

test("the platform URL is required and cannot be the migrator role", () => {
  assert.throws(
    () =>
      readPlatformDatabaseUrl({
        DATABASE_URL_MIGRATOR: "postgres://gotong_migrator:secret@127.0.0.1:5432/gotonghr",
      }),
    /Missing DATABASE_URL_PLATFORM/,
  );
  assert.throws(
    () =>
      readPlatformDatabaseUrl({
        DATABASE_URL_PLATFORM: "postgres://gotong_migrator:secret@127.0.0.1:5432/gotonghr",
      }),
    /platform_admin role/,
  );
  assert.equal(
    readPlatformDatabaseUrl({
      DATABASE_URL_PLATFORM: "postgres://platform_admin:secret@127.0.0.1:5432/gotonghr",
    }),
    "postgres://platform_admin:secret@127.0.0.1:5432/gotonghr",
  );
});
