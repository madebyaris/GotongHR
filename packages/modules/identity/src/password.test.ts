import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookieAttributes } from "./cookies.ts";
import { argon2Parameters, hashPassword, verifyPassword } from "./password.ts";

const rssCapBytes = 64 * 1024 * 1024;

test("Argon2id stays inside the 1 GB API memory cap", async () => {
  await hashPassword("correct horse battery staple");
  const rssBefore = process.memoryUsage().rss;
  const encoded = await hashPassword("another correct horse battery staple");
  const rssAfterOne = process.memoryUsage().rss;
  await Promise.all([
    hashPassword("concurrent horse battery staple one"),
    hashPassword("concurrent horse battery staple two"),
  ]);
  const rssAfterTwo = process.memoryUsage().rss;
  const deltaOne = Math.max(0, rssAfterOne - rssBefore);
  const deltaTwo = Math.max(0, rssAfterTwo - rssBefore);
  console.log(
    `ARGON2_RSS ${JSON.stringify({
      memoryCostKib: argon2Parameters.memoryCost,
      timeCost: argon2Parameters.timeCost,
      parallelism: argon2Parameters.parallelism,
      rssBefore,
      rssAfterOne,
      rssAfterTwo,
      deltaOne,
      deltaTwo,
    })}`,
  );
  assert.match(
    encoded,
    new RegExp(
      `^\\$argon2id\\$v=19\\$m=${argon2Parameters.memoryCost},t=${argon2Parameters.timeCost},p=${argon2Parameters.parallelism}\\$`,
    ),
  );
  assert.equal(await verifyPassword({ hash: encoded, password: "another correct horse battery staple" }), true);
  assert.equal(await verifyPassword({ hash: encoded, password: "wrong horse battery staple" }), false);
  assert.ok(deltaOne < rssCapBytes, `one hash grew RSS by ${deltaOne} bytes`);
  assert.ok(deltaTwo < rssCapBytes * 1.5, `two hashes grew RSS by ${deltaTwo} bytes`);
});

test("session cookies are HttpOnly, Secure, and SameSite=Lax", () => {
  assert.equal(sessionCookieAttributes.httpOnly, true);
  assert.equal(sessionCookieAttributes.secure, true);
  assert.equal(sessionCookieAttributes.sameSite, "lax");
});
