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

const databaseUrlNames = [
  "DATABASE_URL_SUPERUSER",
  "DATABASE_URL_MIGRATOR",
  "DATABASE_URL_APP",
  "DATABASE_URL_PLATFORM",
  "DATABASE_URL_QUEUE",
] as const;

/** Production refuses the passwords published in `.env.example`. */
export function assertProductionSecret(name: string, value: string, mode = process.env.NODE_ENV): void {
  if (mode !== "production") return;
  if (placeholderSecrets.has(value)) {
    throw new Error(`${name} is still a placeholder.`);
  }
}

function databaseUrlPassword(name: string, value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  return parsed.password || undefined;
}

/** Checks discrete passwords and passwords already embedded in DATABASE_URL_*. */
export function assertProductionDatabaseSecrets(env: NodeJS.ProcessEnv): void {
  const mode = env.NODE_ENV;
  for (const [name, value] of [
    ["POSTGRES_PASSWORD", env.POSTGRES_PASSWORD],
    ["MIGRATOR_PASSWORD", env.MIGRATOR_PASSWORD],
    ["APP_PASSWORD", env.APP_PASSWORD],
    ["PLATFORM_PASSWORD", env.PLATFORM_PASSWORD],
    ["QUEUE_PASSWORD", env.QUEUE_PASSWORD],
  ] as const) {
    if (value) assertProductionSecret(name, value, mode);
  }
  for (const name of databaseUrlNames) {
    const value = env[name];
    if (!value) continue;
    const password = databaseUrlPassword(name, value);
    if (password) assertProductionSecret(name, password, mode);
  }
}

/**
 * Fills DATABASE_URL_* from discrete host and password variables.
 * An existing URL is left unchanged. Passwords are percent-encoded.
 * Production checks use `env.NODE_ENV`, including passwords already present in a URL.
 */
export function applyDatabaseUrls(env: NodeJS.ProcessEnv): void {
  assertProductionDatabaseSecrets(env);
  const host = env.POSTGRES_HOST;
  const database = env.POSTGRES_DB || "gotonghr";
  const pairs: Array<[string, string, string | undefined]> = [
    ["DATABASE_URL_SUPERUSER", env.POSTGRES_USER || "postgres", env.POSTGRES_PASSWORD],
    ["DATABASE_URL_MIGRATOR", "gotong_migrator", env.MIGRATOR_PASSWORD],
    ["DATABASE_URL_APP", "app_tenant", env.APP_PASSWORD],
    ["DATABASE_URL_PLATFORM", "platform_admin", env.PLATFORM_PASSWORD],
    ["DATABASE_URL_QUEUE", "gotong_queue", env.QUEUE_PASSWORD],
  ];
  if (!host) return;
  for (const [name, user, password] of pairs) {
    if (env[name] || !password) continue;
    env[name] =
      `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5432/${database}`;
  }
}
