import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { applyDatabaseUrls, loadRepoEnv } from "@gotonghr/db";

const execFileAsync = promisify(execFile);

loadRepoEnv();
applyDatabaseUrls(process.env);

describe("clock sync smoke", { concurrency: 1 }, () => {
  it("runs 20 sequential sync calls under the p95 and RSS caps", { timeout: 180_000 }, async () => {
    const script = fileURLToPath(new URL("../scripts/load-clock.mjs", import.meta.url));
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    const result = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", script, "--calls", "20"],
      { cwd: repo, env: process.env, timeout: 170_000 },
    );
    const line = result.stdout.trim().split("\n").at(-1);
    assert.ok(line, result.stderr);
    const summary = JSON.parse(line) as {
      ok: boolean;
      calls: number;
      p95Ms: number;
      rssBytes: number;
      p95LimitMs: number;
      rssLimitBytes: number;
    };
    assert.equal(summary.calls, 20);
    assert.equal(summary.ok, true);
    assert.ok(summary.p95Ms < summary.p95LimitMs);
    assert.ok(summary.rssBytes < summary.rssLimitBytes);
    assert.equal(summary.p95LimitMs, 300);
    assert.equal(summary.rssLimitBytes, 512 * 1024 * 1024);
  });
});
