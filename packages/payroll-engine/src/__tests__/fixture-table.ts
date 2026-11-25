import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Idr } from "@gotonghr/contracts";
import { parseStatutoryTable, rupiah, type StatutoryTable } from "../index.ts";
import type { GrossTaxableComponents } from "../pph21/gross-taxable.ts";

export function readJson(relativePath: string): unknown {
  const file = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(file, "utf8"));
}

function cloneSynthetic(): Record<string, unknown> {
  const value = readJson("./fixtures/synthetic-pph21.json");
  if (typeof value !== "object" || value === null) {
    throw new Error("Synthetic fixture did not parse.");
  }
  return structuredClone(value) as Record<string, unknown>;
}

/** Labeled synthetic table. The rates are not a DJP table. */
export function loadSyntheticFixture(): StatutoryTable {
  return parseStatutoryTable(cloneSynthetic());
}

export interface JsonBracket {
  readonly up_to: string | null;
  readonly rate_per_scale: number;
}

/** Same synthetic PTKP and Pasal 17 bands, with replacement TER brackets on A, B, and C. */
export function withTerBrackets(brackets: readonly JsonBracket[]): StatutoryTable {
  const copy = cloneSynthetic();
  const ter = copy.ter as Record<string, unknown>;
  const categories = ter.categories as Record<string, unknown>;
  for (const name of ["A", "B", "C"]) {
    categories[name] = { source: "synthetic", brackets };
  }
  return parseStatutoryTable(copy);
}

export function components(
  baseSalary: bigint,
  extra: Partial<Record<keyof GrossTaxableComponents, bigint>> = {},
): GrossTaxableComponents {
  const amount = (key: keyof GrossTaxableComponents, fallback: bigint): Idr => {
    const value = extra[key];
    return rupiah(value ?? fallback);
  };
  return {
    baseSalary: rupiah(baseSalary),
    fixedAllowances: amount("fixedAllowances", 0n),
    overtime: amount("overtime", 0n),
    bonusOrThr: amount("bonusOrThr", 0n),
    employerJkk: amount("employerJkk", 0n),
    employerJkm: amount("employerJkm", 0n),
    employerBpjsKesehatan: amount("employerBpjsKesehatan", 0n),
  };
}
