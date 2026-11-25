import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Argon2id for the 1 GB profile. The API container is 384 MB with a 320 MB
 * V8 heap, so the hash memory has to sit outside that heap and still leave
 * room for the process.
 *
 * Each thread gets its own memoryCost KiB pool. Parallelism stays 1, so one
 * hash reserves 19 MiB (19456 KiB). At most two hashes run at once
 * (`argon2ConcurrencyLimit`), which is about 38 MiB. The per-IP limiter can
 * admit more requests than that; the extra ones wait.
 *
 * The library default algorithm is Argon2id. `verbatimModuleSyntax` cannot
 * import that package's const enum, so the option is omitted and the PHC
 * string is checked for `$argon2id$`.
 *
 * password.test.ts prints ARGON2_RSS while hashes are in flight. One hash must
 * stay under 64 MiB of RSS growth and the sampled peak under 96 MiB. Measured
 * on Node 22.23.4: one hash +65,536 bytes, four overlapping hashes peaked at
 * +40,927,232 bytes with 2 in flight.
 */
export const argon2Parameters = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const argon2ConcurrencyLimit = 2;

let argon2Active = 0;
const argon2Waiters: Array<() => void> = [];

export function argon2InFlight(): number {
  return argon2Active;
}

export function isMalformedArgon2Hash(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "InvalidArg"
  );
}

export async function withArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireArgon2Slot();
  try {
    return await fn();
  } finally {
    releaseArgon2Slot();
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password length is outside the allowed range.");
  }
  return withArgon2Slot(() => hash(password, argon2Parameters));
}

export async function verifyPassword(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  try {
    return await withArgon2Slot(() => verify(data.hash, data.password, argon2Parameters));
  } catch (error) {
    if (isMalformedArgon2Hash(error)) return false;
    throw error;
  }
}

function acquireArgon2Slot(): Promise<void> {
  if (argon2Active < argon2ConcurrencyLimit) {
    argon2Active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    argon2Waiters.push(() => {
      argon2Active += 1;
      resolve();
    });
  });
}

function releaseArgon2Slot(): void {
  argon2Active -= 1;
  const next = argon2Waiters.shift();
  if (next) next();
}
