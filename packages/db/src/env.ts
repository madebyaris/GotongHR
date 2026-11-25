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
