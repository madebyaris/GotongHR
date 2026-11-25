import { civilDateToIso } from "../civil-date.ts";
import {
  GoldenCaseMismatchError,
  GrossUpDidNotConvergeError,
  InvalidStatutoryTableError,
  MissingStatutoryValueError,
  PayrollInputError,
} from "../errors.ts";
import { assertGoldenCase, parseGoldenFile, type GoldenCase } from "../pph21/golden-case.ts";
import { parseStatutoryTable } from "./parse.ts";
import type { StatutoryTable } from "./types.ts";

export type StatutoryPublishVerdict =
  | {
      readonly ok: true;
      readonly ruleType: "pph21";
      readonly effectiveFrom: string;
      readonly effectiveTo: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

/**
 * Dry-run for a publish. `goldenFile` is the shipped verified-case document.
 * A draft, a missing source, a broken table, or a verified case this window
 * covers and does not match, all come back as `ok: false`. Cases outside the
 * window are skipped. A bad golden file throws. This function does not read
 * the filesystem and does not invent DJP rates.
 */
export function verifyStatutoryPublish(
  payload: unknown,
  goldenFile: unknown,
): StatutoryPublishVerdict {
  let table: StatutoryTable;
  try {
    table = parseStatutoryTable(payload);
  } catch (error) {
    if (error instanceof InvalidStatutoryTableError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
  if (table.status !== "published") {
    return { ok: false, message: "A draft statutory table cannot be published." };
  }
  const missing = missingSourcePath(payload, "");
  if (missing !== null) {
    return { ok: false, message: `Statutory source ${missing} is missing.` };
  }
  const golden = parseShippedGolden(goldenFile);
  try {
    for (const goldenCase of golden) {
      const iso = civilDateToIso(goldenCase.payrollDate);
      if (iso < table.effectiveFrom || iso > table.effectiveTo) continue;
      assertGoldenCase(table, goldenCase);
    }
  } catch (error) {
    const message = publishFailure(error);
    if (message !== null) return { ok: false, message };
    throw error;
  }
  return {
    ok: true,
    ruleType: table.ruleType,
    effectiveFrom: table.effectiveFrom,
    effectiveTo: table.effectiveTo,
  };
}

function parseShippedGolden(goldenFile: unknown): readonly GoldenCase[] {
  try {
    return parseGoldenFile(goldenFile).cases;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Golden file is invalid.";
    throw new Error(`Shipped golden file cannot be read: ${message}`, { cause: error });
  }
}

function publishFailure(error: unknown): string | null {
  if (
    error instanceof GoldenCaseMismatchError ||
    error instanceof MissingStatutoryValueError ||
    error instanceof PayrollInputError ||
    error instanceof GrossUpDidNotConvergeError ||
    error instanceof InvalidStatutoryTableError
  ) {
    return error.message;
  }
  return null;
}

function missingSourcePath(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = missingSourcePath(value[index], `${path}.${index}`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, child] of Object.entries(value)) {
    const next = path.length === 0 ? key : `${path}.${key}`;
    if (key === "source" && child === "missing") return next;
    const found = missingSourcePath(child, next);
    if (found !== null) return found;
  }
  return null;
}
