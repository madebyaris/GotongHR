import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { generatePayslipPdf } from "./generate-payslip-pdf.ts";
import { samplePayslip } from "./sample-payslip.ts";

function readVm(field: "VmRSS" | "VmHWM"): number {
  const status = readFileSync("/proc/self/status", "utf8");
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(status);
  const kb = match?.[1];
  if (kb === undefined) {
    throw new Error(`${field} is missing from /proc/self/status.`);
  }
  return Number(kb) * 1024;
}

function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") {
    throw new Error("RSS probe requires node --expose-gc.");
  }
  gc();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface Sampler {
  arm: (hwmBefore: number) => Promise<void>;
  stop: () => Promise<number>;
}

function openSampler(): Promise<Sampler> {
  const worker = new Worker(new URL("./rss-sampler.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const onStartupError = (error: Error) => {
      reject(error);
    };
    worker.once("error", onStartupError);
    worker.once("online", () => {
      worker.off("error", onStartupError);
      resolve({
        arm(hwmBefore: number) {
          return new Promise((done, fail) => {
            const onMessage = (message: unknown) => {
              if (message !== "armed") {
                return;
              }
              worker.off("message", onMessage);
              done();
            };
            worker.on("message", onMessage);
            worker.once("error", fail);
            worker.postMessage({ type: "arm", hwmBefore });
          });
        },
        stop() {
          return new Promise((done, fail) => {
            const onMessage = (message: unknown) => {
              if (typeof message !== "number") {
                return;
              }
              worker.off("message", onMessage);
              void worker.terminate().then(() => done(message), fail);
            };
            worker.on("message", onMessage);
            worker.once("error", fail);
            worker.postMessage({ type: "stop" });
          });
        },
      });
    });
  });
}

async function main(): Promise<void> {
  const payslip = samplePayslip();
  const password = "17081995";
  await generatePayslipPdf(payslip, password);
  collectGarbage();
  await delay(20);
  collectGarbage();

  const sampler = await openSampler();
  collectGarbage();
  await delay(20);
  collectGarbage();

  const baseline = readVm("VmRSS");
  const hwmBefore = readVm("VmHWM");
  process.stdout.write(`BASELINE ${baseline}\n`);
  await sampler.arm(hwmBefore);

  const pdf = await generatePayslipPdf(payslip, password);
  const rssAfter = readVm("VmRSS");
  const hwmAfter = readVm("VmHWM");
  const sampled = await sampler.stop();
  const peak = Math.max(rssAfter, sampled, hwmAfter > hwmBefore ? hwmAfter : 0);
  const delta = peak - baseline;
  process.stdout.write(
    `RESULT ${JSON.stringify({ baseline, peak, delta, bytes: pdf.byteLength, hwmBefore, hwmAfter, sampled, rssAfter })}\n`,
  );
  await delay(30);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
