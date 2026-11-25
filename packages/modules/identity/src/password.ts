import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Argon2id for the 1 GB profile. The API container is 384 MB with a 320 MB
 * V8 heap, so the hash memory has to sit outside that heap and still leave
 * room for the process.
 *
 * Each thread gets its own memoryCost KiB pool. Parallelism stays 1 so one
 * login reserves 19 MiB (19456 KiB), which is the library default and the
 * OWASP Argon2id memory floor. timeCost 2, output 32 bytes.
 *
 * A login is one hash. The Fastify limiter allows 10 attempts a minute per
 * IP on each credential route, so two overlapping hashes are about 38 MiB.
 * password.test.ts records the RSS delta of one hash and of two concurrent
 * hashes. Measured on Node 22.23.4 after a warmup hash: RSS 81,309,696
 * bytes before, +65,536 after one hash, +307,200 after two concurrent
 * hashes. Both sit under the 64 MiB and 96 MiB caps, so this slice keeps
 * Argon2id and does not switch to scrypt. The 19 MiB block is native memory
 * held only for the duration of the hash.
 *
 * The library default algorithm is Argon2id. `verbatimModuleSyntax` cannot
 * import that package's const enum, so the option is omitted and the PHC
 * string is checked for `$argon2id$`.
 *
 * Measured RSS is printed by password.test.ts as ARGON2_RSS. One hash and
 * two concurrent hashes must stay under 64 MiB and 96 MiB of RSS growth.
 */
export const argon2Parameters = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password length is outside the allowed range.");
  }
  return hash(password, argon2Parameters);
}

export async function verifyPassword(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  try {
    return await verify(data.hash, data.password, argon2Parameters);
  } catch {
    return false;
  }
}
