import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionCookieAttributes } from "./cookies.ts";
import {
  argon2ConcurrencyLimit,
  argon2InFlight,
  argon2Parameters,
  argon2QueueLimit,
  hashPassword,
  isMalformedArgon2Hash,
  verifyPassword,
  withArgon2Slot,
} from "./password.ts";

const oneHashCap = 64 * 1024 * 1024;
const concurrentCap = 96 * 1024 * 1024;

describe("argon2", { concurrency: 1 }, () => {
  it("keeps at most two hashes in flight and inside the RSS cap", async () => {
    await hashPassword("correct horse battery staple");
    const rssBefore = process.memoryUsage().rss;
    const encoded = await hashPassword("another correct horse battery staple");
    const rssAfterOne = process.memoryUsage().rss;

    let peakInFlight = 0;
    let peakRss = rssBefore;
    let finished = 0;
    const pending = Array.from({ length: 4 }, (_, index) =>
      hashPassword(`concurrent-password-${index}-ok`).finally(() => {
        finished += 1;
      }),
    );
    while (finished < 4) {
      peakInFlight = Math.max(peakInFlight, argon2InFlight());
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(pending);

    const deltaOne = Math.max(0, rssAfterOne - rssBefore);
    const deltaPeak = Math.max(0, peakRss - rssBefore);
    console.log(
      `ARGON2_RSS ${JSON.stringify({
        memoryCostKib: argon2Parameters.memoryCost,
        timeCost: argon2Parameters.timeCost,
        parallelism: argon2Parameters.parallelism,
        concurrencyLimit: argon2ConcurrencyLimit,
        rssBefore,
        rssAfterOne,
        peakRss,
        deltaOne,
        deltaPeak,
        peakInFlight,
      })}`,
    );
    assert.match(
      encoded,
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${argon2Parameters.memoryCost},t=${argon2Parameters.timeCost},p=${argon2Parameters.parallelism}\\$`,
      ),
    );
    assert.equal(
      await verifyPassword({ hash: encoded, password: "another correct horse battery staple" }),
      true,
    );
    assert.equal(await verifyPassword({ hash: encoded, password: "wrong horse battery staple" }), false);
    assert.equal(await verifyPassword({ hash: "not-a-hash", password: "wrong horse battery staple" }), false);
    assert.ok(deltaOne < oneHashCap, `one hash grew RSS by ${deltaOne} bytes`);
    assert.ok(deltaPeak < concurrentCap, `peak RSS grew by ${deltaPeak} bytes`);
    assert.ok(peakInFlight >= 1 && peakInFlight <= argon2ConcurrencyLimit);
  });

  it("caps overlapping work at two", async () => {
    let current = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withArgon2Slot(async () => {
          current += 1;
          peak = Math.max(peak, current);
          await new Promise((resolve) => setTimeout(resolve, 30));
          current -= 1;
        }),
      ),
    );
    assert.equal(peak, argon2ConcurrencyLimit);
    assert.equal(argon2InFlight(), 0);
  });

  it("rejects when the waiter queue is full", async () => {
    const release: Array<() => void> = [];
    const holders = [0, 1].map(() =>
      withArgon2Slot(
        () =>
          new Promise<void>((resolve) => {
            release.push(resolve);
          }),
      ),
    );
    while (argon2InFlight() < argon2ConcurrencyLimit) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const waiting = Array.from({ length: argon2QueueLimit }, () =>
      withArgon2Slot(async () => undefined),
    );
    await assert.rejects(withArgon2Slot(async () => undefined), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("statusCode" in error ? error.statusCode : undefined, 503);
      assert.match(error.message, /overloaded/);
      return true;
    });
    for (const done of release) done();
    await Promise.all(holders);
    await Promise.all(waiting);
    assert.equal(argon2InFlight(), 0);
  });

  it("treats only malformed hashes as a failed password", () => {
    assert.equal(isMalformedArgon2Hash({ code: "InvalidArg" }), true);
    assert.equal(isMalformedArgon2Hash(new Error("database is down")), false);
    assert.equal(isMalformedArgon2Hash({ code: "ECONNRESET" }), false);
  });
});

describe("cookies", () => {
  it("are HttpOnly, Secure, and SameSite=Lax", () => {
    assert.equal(sessionCookieAttributes.httpOnly, true);
    assert.equal(sessionCookieAttributes.secure, true);
    assert.equal(sessionCookieAttributes.sameSite, "lax");
  });
});
