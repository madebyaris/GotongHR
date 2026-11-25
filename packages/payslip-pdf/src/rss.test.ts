import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RSS_LIMIT_BYTES = 20 * 1024 * 1024;

function readVmRss(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  const kb = match?.[1];
  if (kb === undefined) {
    throw new Error(`VmRSS is missing for pid ${pid}.`);
  }
  return Number(kb) * 1024;
}

test("peak RSS for one payslip after warmup stays under 20 MB", async () => {
  const probePath = fileURLToPath(new URL("./rss-probe.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--expose-gc", "--experimental-strip-types", probePath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let baseline = 0;
  let sampledPeak = 0;
  let running = false;
  const timer = setInterval(() => {
    if (!running || child.pid === undefined) {
      return;
    }
    try {
      sampledPeak = Math.max(sampledPeak, readVmRss(child.pid));
    } catch {
      running = false;
    }
  }, 1);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("BASELINE ") && !running) {
      const match = /BASELINE (\d+)/.exec(stdout);
      baseline = Number(match?.[1] ?? "0");
      running = true;
      if (child.pid !== undefined) {
        try {
          sampledPeak = readVmRss(child.pid);
        } catch {
          sampledPeak = baseline;
        }
      }
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error(`RSS probe timed out.\n${stderr}`));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve(code ?? 1);
    });
  }).finally(() => {
    clearInterval(timer);
    running = false;
  });

  assert.equal(exitCode, 0, stderr);
  const resultMatch = /RESULT (\{.*\})/.exec(stdout);
  assert.ok(resultMatch?.[1], `probe output missing RESULT\n${stdout}\n${stderr}`);
  const result = JSON.parse(resultMatch[1]) as {
    baseline: number;
    peak: number;
    delta: number;
    bytes: number;
  };
  const peak = Math.max(result.peak, sampledPeak);
  const delta = peak - result.baseline;
  console.log(
    `payslip pdf RSS delta ${delta} bytes (child ${result.delta}, sampled peak ${sampledPeak}, baseline ${result.baseline}, pdf ${result.bytes} bytes)`,
  );
  assert.ok(result.bytes > 1000);
  assert.equal(result.baseline, baseline);
  assert.ok(
    delta < RSS_LIMIT_BYTES,
    `peak RSS delta ${delta} bytes is not under ${RSS_LIMIT_BYTES} bytes`,
  );
});
