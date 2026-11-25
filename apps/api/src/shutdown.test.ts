import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runShutdown } from "./shutdown.ts";

function capture() {
  const writes: string[] = [];
  const codes: number[] = [];
  return {
    writes,
    codes,
    io: {
      exit(value: number) {
        codes.push(value);
      },
      write(line: string) {
        writes.push(line);
      },
    },
  };
}

describe("shutdown", { concurrency: 1 }, () => {
  it("exits 0 when close finishes", async () => {
    const seen = capture();
    runShutdown(async () => {}, seen.io);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.codes, [0]);
    assert.match(seen.writes.join(""), /shutdown started/);
  });

  it("logs a close failure and exits 1", async () => {
    const seen = capture();
    runShutdown(async () => {
      throw new Error("pool");
    }, seen.io);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.codes, [1]);
    assert.match(seen.writes.join(""), /pool/);
  });

  it("exits 1 when close stalls", async () => {
    const seen = capture();
    runShutdown(() => new Promise(() => {}), seen.io, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen.codes, [1]);
    assert.match(seen.writes.join(""), /shutdown stalled/);
  });

  it("exits once when close finishes after the deadline", async () => {
    const seen = capture();
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    runShutdown(() => pending, seen.io, 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.codes, [1]);
  });
});
