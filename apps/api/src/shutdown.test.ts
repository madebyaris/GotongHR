import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runShutdown } from "./shutdown.ts";

function capture() {
  const writes: string[] = [];
  let code: number | undefined;
  return {
    writes,
    io: {
      exit(value: number) {
        code = value;
      },
      write(line: string) {
        writes.push(line);
      },
    },
    code: () => code,
  };
}

describe("shutdown", { concurrency: 1 }, () => {
  it("exits 0 when close finishes", async () => {
    const seen = capture();
    runShutdown(async () => {}, seen.io);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.code(), 0);
    assert.match(seen.writes.join(""), /shutdown started/);
  });

  it("logs a close failure and exits 1", async () => {
    const seen = capture();
    runShutdown(async () => {
      throw new Error("pool");
    }, seen.io);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.code(), 1);
    assert.match(seen.writes.join(""), /pool/);
  });

  it("exits 1 when close stalls", async () => {
    const seen = capture();
    runShutdown(() => new Promise(() => {}), seen.io, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.code(), 1);
    assert.match(seen.writes.join(""), /shutdown stalled/);
  });
});
