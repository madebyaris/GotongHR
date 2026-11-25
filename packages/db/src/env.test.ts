import assert from "node:assert/strict";
import test from "node:test";
import { applyDatabaseUrls, assertProductionSecret } from "./env.ts";

test("database urls encode reserved characters in the password", () => {
  const env: NodeJS.ProcessEnv = {
    POSTGRES_HOST: "postgres",
    POSTGRES_DB: "gotonghr",
    POSTGRES_PASSWORD: "p@ss/word",
    APP_PASSWORD: "app",
  };
  applyDatabaseUrls(env);
  assert.equal(
    env.DATABASE_URL_SUPERUSER,
    "postgres://postgres:p%40ss%2Fword@postgres:5432/gotonghr",
  );
  assert.equal(env.DATABASE_URL_APP, "postgres://app_tenant:app@postgres:5432/gotonghr");
  assert.equal(env.DATABASE_URL_MIGRATOR, undefined);
});

test("an existing database url is left unchanged", () => {
  const env: NodeJS.ProcessEnv = {
    POSTGRES_HOST: "postgres",
    POSTGRES_PASSWORD: "secret",
    DATABASE_URL_SUPERUSER: "postgres://postgres:secret@127.0.0.1:5432/gotonghr",
  };
  applyDatabaseUrls(env);
  assert.equal(env.DATABASE_URL_SUPERUSER, "postgres://postgres:secret@127.0.0.1:5432/gotonghr");
});

test("production rejects a placeholder password", () => {
  assert.throws(
    () => assertProductionSecret("APP_PASSWORD", "change-me-app", "production"),
    /placeholder/,
  );
  assert.doesNotThrow(() => assertProductionSecret("APP_PASSWORD", "change-me-app", "test"));
});

test("production applyDatabaseUrls rejects a placeholder password from the env object", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.throws(
      () =>
        applyDatabaseUrls({
          NODE_ENV: "production",
          POSTGRES_HOST: "postgres",
          POSTGRES_PASSWORD: "change-me",
        }),
      /POSTGRES_PASSWORD is still a placeholder/,
    );
    assert.throws(
      () =>
        applyDatabaseUrls({
          NODE_ENV: "production",
          DATABASE_URL_APP: "postgres://app_tenant:change-me-app@127.0.0.1:5432/gotonghr",
        }),
      /DATABASE_URL_APP is still a placeholder/,
    );
    assert.doesNotThrow(() =>
      applyDatabaseUrls({
        NODE_ENV: "test",
        POSTGRES_HOST: "postgres",
        POSTGRES_PASSWORD: "change-me",
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
