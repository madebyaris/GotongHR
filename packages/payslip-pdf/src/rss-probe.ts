import { readFileSync } from "node:fs";
import { generatePayslipPdf } from "./generate-payslip-pdf.ts";
import { samplePayslip } from "./sample-payslip.ts";

function readVmRss(): number {
  const status = readFileSync("/proc/self/status", "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  const kb = match?.[1];
  if (kb === undefined) {
    throw new Error("VmRSS is missing from /proc/self/status.");
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

async function main(): Promise<void> {
  const payslip = samplePayslip();
  const password = "17081995";
  await generatePayslipPdf(payslip, password);
  collectGarbage();
  await delay(20);
  collectGarbage();

  const baseline = readVmRss();
  process.stdout.write(`BASELINE ${baseline}\n`);
  await delay(30);

  const pdf = await generatePayslipPdf(payslip, password);
  const peak = readVmRss();
  const delta = peak - baseline;
  process.stdout.write(
    `RESULT ${JSON.stringify({ baseline, peak, delta, bytes: pdf.byteLength })}\n`,
  );
  await delay(30);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
