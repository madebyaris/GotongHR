import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoretaxSlipType } from "./types.ts";

/** Directory of optional official DJP schemas. Empty in this repo until a pilot adds them. */
export const coretaxXsdDirectory = fileURLToPath(new URL("./xsd/", import.meta.url));

export type XsdSkipReason = "xsd missing" | `xsd missing for ${CoretaxSlipType}`;

export type XsdValidation =
  | { readonly status: "skipped"; readonly reason: XsdSkipReason }
  | { readonly status: "valid"; readonly schemaFile: string }
  | { readonly status: "invalid"; readonly schemaFile: string; readonly errors: readonly string[] }
  | { readonly status: "unavailable"; readonly schemaFile: string; readonly reason: string };

const SCHEMA_TOKENS: Record<CoretaxSlipType, readonly string[]> = {
  BPMP: ["MMPAYROLL", "BPMP"],
  BP21: ["BP21"],
  BP26: ["BP26"],
  BPA1: ["BPA1", "A1"],
};

/**
 * Validates XML against a local XSD when one is present.
 * When src/coretax/xsd has no .xsd file, the result is skipped with reason "xsd missing".
 * This function does not download a schema.
 */
export function validateCoretaxXml(input: {
  readonly xml: string;
  readonly slipType: CoretaxSlipType;
  readonly xsdDirectory?: string;
}): XsdValidation {
  const directory = input.xsdDirectory ?? coretaxXsdDirectory;
  const files = findCoretaxXsdFiles(directory);
  if (files.length === 0) return { status: "skipped", reason: "xsd missing" };
  const schemaName = schemaFileFor(input.slipType, files);
  if (schemaName === undefined) return { status: "skipped", reason: `xsd missing for ${input.slipType}` };
  const schemaPath = path.join(directory, schemaName);
  const child = spawnSync("xmllint", ["--nonet", "--schema", schemaPath, "--noout", "-"], {
    input: input.xml,
    encoding: "utf8",
  });
  if (child.error) {
    const code = "code" in child.error ? String(child.error.code) : "";
    if (code === "ENOENT") {
      return { status: "unavailable", schemaFile: schemaName, reason: "xmllint is not installed." };
    }
    return { status: "unavailable", schemaFile: schemaName, reason: child.error.message };
  }
  if (child.status === 0) return { status: "valid", schemaFile: schemaName };
  const errors = `${child.stderr ?? ""}\n${child.stdout ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { status: "invalid", schemaFile: schemaName, errors };
}

function schemaFileFor(slipType: CoretaxSlipType, files: readonly string[]): string | undefined {
  for (const token of SCHEMA_TOKENS[slipType]) {
    const match = files.find((name) => name.toUpperCase().includes(token));
    if (match !== undefined) return match;
  }
  return undefined;
}

export function findCoretaxXsdFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".xsd"))
    .filter((name) => !name.includes("/") && !name.includes("\\") && !name.includes(".."))
    .sort();
}
