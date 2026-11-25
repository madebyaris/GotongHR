import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const P95_LIMIT_MS = 300;
const RSS_LIMIT_BYTES = 512 * 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../src/clock-load-app.ts");
const repoRoot = path.resolve(here, "../../..");

const calls = readCalls(process.argv.slice(2));
const child = spawn(process.execPath, ["--experimental-strip-types", serverPath], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  const ready = await waitReady(child);
  await syncOnce(ready, calls, -1);
  const samples = [];
  let rssBytes = readRss(child.pid);
  const started = Date.now() - (calls + 5) * 1000;
  for (let index = 0; index < calls; index += 1) {
    const began = performance.now();
    await syncOnce(ready, calls, index, new Date(started + index * 1000).toISOString());
    samples.push(performance.now() - began);
    rssBytes = Math.max(rssBytes, readRss(child.pid));
  }
  const summary = {
    ok: false,
    calls,
    p95Ms: round(p95(samples)),
    maxMs: round(Math.max(...samples)),
    rssBytes,
    p95LimitMs: P95_LIMIT_MS,
    rssLimitBytes: RSS_LIMIT_BYTES,
  };
  child.kill("SIGTERM");
  const code = await waitExit(child);
  summary.ok = summary.p95Ms < P95_LIMIT_MS && summary.rssBytes < RSS_LIMIT_BYTES && code === 0;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.ok) {
    process.stderr.write(
      `clock load failed: p95 ${summary.p95Ms} ms, rss ${summary.rssBytes} bytes, exit ${code}\n`,
    );
    process.exit(1);
  }
} catch (error) {
  child.kill("SIGTERM");
  const message = error instanceof Error ? error.message : "clock load failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readCalls(argv) {
  const flag = argv.indexOf("--calls");
  const raw = flag === -1 ? process.env.CLOCK_LOAD_CALLS : argv[flag + 1];
  if (raw === undefined || raw === "") return 300;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--calls must be a positive integer");
  }
  return value;
}

function waitReady(proc) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("clock load server did not start")), 120_000);
    const onExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`clock load server exited ${code} before it was ready`));
    };
    proc.once("exit", onExit);
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((item) => item.startsWith("READY "));
      if (!line) return;
      clearTimeout(timer);
      proc.off("exit", onExit);
      const parts = line.split(" ");
      const port = Number(parts[1]);
      const employeeId = parts[2];
      if (!Number.isInteger(port) || !employeeId) {
        reject(new Error(`bad ready line: ${line}`));
        return;
      }
      resolve({ port, employeeId });
    });
  });
}

async function syncOnce(ready, total, index, capturedAt) {
  const when = capturedAt ?? new Date(Date.now() - (total + 6) * 1000).toISOString();
  const payload = JSON.stringify({
    events: [
      {
        idempotencyKey: uuidv7(),
        employeeId: ready.employeeId,
        punchType: "clock_in",
        capturedAt: when,
        syncSource: "online",
        lat: 0,
        lng: 0,
      },
    ],
  });
  const response = await post(ready.port, payload);
  if (response.status !== 200) {
    throw new Error(`sync ${index} returned ${response.status}: ${response.body}`);
  }
  const parsed = JSON.parse(response.body);
  const decision = parsed.data?.events?.[0];
  if (!decision || decision.reviewStatus !== "ok" || decision.duplicate !== false) {
    throw new Error(`sync ${index} was not an accepted punch: ${response.body}`);
  }
}

function post(port, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/mobile/attendance/sync",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("sync timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

function readRss(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (!match?.[1]) throw new Error("VmRSS missing");
  return Number(match[1]) * 1024;
}

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function waitExit(proc) {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 15_000);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function uuidv7(now = Date.now()) {
  const bytes = new Uint8Array(randomBytes(16));
  const time = BigInt(now);
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
