import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyStatutoryPublish } from "@gotonghr/payroll-engine";
import type { StatutoryPublishVerdict } from "@gotonghr/platform";

let shippedGolden: unknown;

/**
 * The canonical file lives in the payroll-engine package.
 * The build also copies it beside the compiled tables module.
 */
function readShippedGoldenFile(): unknown {
  const entry = fileURLToPath(import.meta.resolve("@gotonghr/payroll-engine"));
  const distDir = dirname(entry);
  const packageRoot = dirname(distDir);
  const candidates = [
    join(packageRoot, "src", "__tests__", "golden", "pph21.verified.json"),
    join(distDir, "tables", "pph21.verified.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  }
  throw new Error("Shipped PPh 21 golden file is missing.");
}

function goldenFile(): unknown {
  shippedGolden ??= readShippedGoldenFile();
  return shippedGolden;
}

/** Payroll-engine check for a statutory publish. Wired in `composition.ts`. */
export function verifyStatutoryPayload(payload: unknown): StatutoryPublishVerdict {
  const verdict = verifyStatutoryPublish(payload, goldenFile());
  if (!verdict.ok) return { ok: false, message: verdict.message };
  return {
    ok: true,
    ruleType: verdict.ruleType,
    effectiveFrom: verdict.effectiveFrom,
    effectiveTo: verdict.effectiveTo,
  };
}
