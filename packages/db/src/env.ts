import { existsSync } from "node:fs";
import path from "node:path";

/** Loads the repo-root `.env` without overriding variables that are already set. */
export function loadRepoEnv(start = process.cwd()): void {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

const placeholderSecrets = new Set([
  "change-me",
  "change-me-migrator",
  "change-me-app",
  "change-me-platform",
  "change-me-queue",
]);

/** Production refuses the passwords published in `.env.example`. */
export function assertProductionSecret(name: string, value: string, mode = process.env.NODE_ENV): void {
  if (mode !== "production") return;
  if (placeholderSecrets.has(value)) {
    throw new Error(`${name} is still a placeholder.`);
  }
}

/**
 * Fills DATABASE_URL_* from discrete host and password variables.
 * An existing URL is left unchanged. Passwords are percent-encoded.
 */
export function applyDatabaseUrls(env: NodeJS.ProcessEnv): void {
  const host = env.POSTGRES_HOST;
  const database = env.POSTGRES_DB || "gotonghr";
  const pairs: Array<[string, string, string | undefined]> = [
    ["DATABASE_URL_SUPERUSER", env.POSTGRES_USER || "postgres", env.POSTGRES_PASSWORD],
    ["DATABASE_URL_MIGRATOR", "gotong_migrator", env.MIGRATOR_PASSWORD],
    ["DATABASE_URL_APP", "app_tenant", env.APP_PASSWORD],
    ["DATABASE_URL_PLATFORM", "platform_admin", env.PLATFORM_PASSWORD],
    ["DATABASE_URL_QUEUE", "gotong_queue", env.QUEUE_PASSWORD],
  ];
  if (host) {
    for (const [name, user, password] of pairs) {
      if (env[name] || !password) continue;
      env[name] =
        `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5432/${database}`;
    }
  }
  for (const [name, value] of [
    ["POSTGRES_PASSWORD", env.POSTGRES_PASSWORD],
    ["MIGRATOR_PASSWORD", env.MIGRATOR_PASSWORD],
    ["APP_PASSWORD", env.APP_PASSWORD],
    ["PLATFORM_PASSWORD", env.PLATFORM_PASSWORD],
    ["QUEUE_PASSWORD", env.QUEUE_PASSWORD],
  ] as const) {
    if (value) assertProductionSecret(name, value);
  }
}
