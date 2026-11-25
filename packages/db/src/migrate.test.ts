import assert from "node:assert/strict";
import test from "node:test";
import { grantSchemaDml, migrateEnvFrom, QUEUE_ROLE } from "./migrate.ts";

const realPasswords = {
  MIGRATOR_PASSWORD: "real-migrator-secret",
  APP_PASSWORD: "real-app-secret",
  PLATFORM_PASSWORD: "real-platform-secret",
  QUEUE_PASSWORD: "real-queue-secret",
};

test("migrateEnvFrom rejects a placeholder password inside an existing database url", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.throws(
      () =>
        migrateEnvFrom({
          NODE_ENV: "production",
          DATABASE_URL_SUPERUSER: "postgres://postgres:secret@127.0.0.1:5432/gotonghr",
          DATABASE_URL_MIGRATOR:
            "postgres://gotong_migrator:change-me-migrator@127.0.0.1:5432/gotonghr",
          ...realPasswords,
        }),
      /DATABASE_URL_MIGRATOR is still a placeholder/,
    );
    assert.doesNotThrow(() =>
      migrateEnvFrom({
        NODE_ENV: "test",
        DATABASE_URL_SUPERUSER: "postgres://postgres:change-me@127.0.0.1:5432/gotonghr",
        DATABASE_URL_MIGRATOR:
          "postgres://gotong_migrator:change-me-migrator@127.0.0.1:5432/gotonghr",
        ...realPasswords,
        MIGRATOR_PASSWORD: "change-me-migrator",
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("grantSchemaDml rejects schemas other than the queue schema", async () => {
  await assert.rejects(
    () =>
      grantSchemaDml(
        "postgres://postgres:secret@127.0.0.1:5432/gotonghr",
        "public",
        QUEUE_ROLE,
      ),
    /queue schema/,
  );
});
