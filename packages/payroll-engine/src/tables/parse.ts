import { ptkpStatuses, type PtkpStatus } from "@gotonghr/contracts";
import { isIsoDate } from "../civil-date.ts";
import { InvalidStatutoryTableError } from "../errors.ts";
import {
  terCategories,
  type Pasal17Band,
  type SourcedAmount,
  type StatutoryTable,
  type TerBracket,
  type TerCategory,
  type TerCategoryTable,
} from "./types.ts";

const PKP_STEP = 1000n;
const MAX_BRACKETS = 80;
const MAX_PASAL17_BANDS = 20;

function invalid(message: string): never {
  throw new InvalidStatutoryTableError(message);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) invalid(`${path}.${key} is not a statutory table field.`);
  }
}

function requireKey(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(record, key)) invalid(`${path}.${key} is required.`);
  return record[key];
}

function parseSource(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(value)) {
    invalid(`${path} must be a short source label.`);
  }
  return value;
}

function parseRupiah(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    invalid(`${path} must be a non-negative integer string.`);
  }
  return BigInt(value);
}

function parseUpTo(value: unknown, path: string): bigint | null {
  if (value === null) return null;
  return parseRupiah(value, path);
}

function parseSmallInt(value: unknown, path: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      invalid(`${path} must be a non-negative integer.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  invalid(`${path} must be a non-negative integer.`);
}

function parseIso(value: unknown, path: string): string {
  if (!isIsoDate(value)) invalid(`${path} must be YYYY-MM-DD.`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function parseFixture(record: Record<string, unknown>): "synthetic" | null {
  const hasFixture = Object.hasOwn(record, "fixture");
  const hasFlag = Object.hasOwn(record, "not_official");
  const hasNote = Object.hasOwn(record, "note");
  if (!hasFixture && !hasFlag && !hasNote) return null;
  if (record.fixture !== "synthetic" || record.not_official !== true) {
    invalid("A synthetic fixture must set fixture to synthetic and not_official to true.");
  }
  if (hasNote) {
    const note = record.note;
    if (typeof note !== "string" || note.length === 0 || note.length > 240) {
      invalid("table.note must be a short string.");
    }
  }
  return "synthetic";
}

function parsePasal17(value: unknown): StatutoryTable["pasal17"] {
  const record = asRecord(value, "pasal17");
  rejectUnknown(record, ["source", "pkp_round_down_to", "bands"], "pasal17");
  const source = parseSource(requireKey(record, "source", "pasal17"), "pasal17.source");
  const step = parseRupiah(requireKey(record, "pkp_round_down_to", "pasal17"), "pasal17.pkp_round_down_to");
  if (step !== PKP_STEP) invalid("pasal17.pkp_round_down_to must be 1000.");
  const bandsValue = requireKey(record, "bands", "pasal17");
  if (!Array.isArray(bandsValue) || bandsValue.length < 1 || bandsValue.length > MAX_PASAL17_BANDS) {
    invalid("pasal17.bands must contain between 1 and 20 bands.");
  }
  const bands: Pasal17Band[] = [];
  let previousUpTo: bigint | null = null;
  for (let index = 0; index < bandsValue.length; index += 1) {
    const path = `pasal17.bands.${index}`;
    const entry = asRecord(bandsValue[index], path);
    rejectUnknown(entry, ["up_to", "rate_per_scale", "rate_scale"], path);
    const upTo = parseUpTo(requireKey(entry, "up_to", path), `${path}.up_to`);
    const rateScale = parseSmallInt(requireKey(entry, "rate_scale", path), `${path}.rate_scale`);
    if (rateScale <= 0n || rateScale > 1_000_000n) invalid(`${path}.rate_scale is outside the allowed range.`);
    const ratePerScale = parseSmallInt(requireKey(entry, "rate_per_scale", path), `${path}.rate_per_scale`);
    if (ratePerScale > rateScale) invalid(`${path}.rate_per_scale cannot exceed its scale.`);
    const isLast = index === bandsValue.length - 1;
    if (isLast && upTo !== null) invalid("pasal17.bands must end with an open band.");
    if (!isLast && upTo === null) invalid(`${path}.up_to cannot be open before the last band.`);
    if (upTo !== null) {
      if (upTo % PKP_STEP !== 0n) invalid(`${path}.up_to must be a multiple of 1000.`);
      if (previousUpTo !== null && upTo <= previousUpTo) invalid(`${path}.up_to must increase.`);
      previousUpTo = upTo;
    }
    bands.push({ upTo, ratePerScale, rateScale });
  }
  return { source, pkpRoundDownTo: step, bands };
}

function parseBiaya(value: unknown): StatutoryTable["biayaJabatan"] {
  const record = asRecord(value, "biaya_jabatan");
  rejectUnknown(
    record,
    ["source", "rate_per_scale", "rate_scale", "rounding", "monthly_cap"],
    "biaya_jabatan",
  );
  const source = parseSource(requireKey(record, "source", "biaya_jabatan"), "biaya_jabatan.source");
  if (record.rounding !== "floor") {
    invalid("biaya_jabatan.rounding must be floor until a verified example changes it.");
  }
  const rateScale = parseSmallInt(requireKey(record, "rate_scale", "biaya_jabatan"), "biaya_jabatan.rate_scale");
  if (rateScale <= 0n || rateScale > 1_000_000n) invalid("biaya_jabatan.rate_scale is outside the allowed range.");
  const ratePerScale = parseSmallInt(
    requireKey(record, "rate_per_scale", "biaya_jabatan"),
    "biaya_jabatan.rate_per_scale",
  );
  if (ratePerScale > rateScale) invalid("biaya_jabatan.rate_per_scale cannot exceed its scale.");
  const monthlyCap = parseRupiah(requireKey(record, "monthly_cap", "biaya_jabatan"), "biaya_jabatan.monthly_cap");
  return { source, ratePerScale, rateScale, rounding: "floor", monthlyCap };
}

function parseSourcedAmount(value: unknown, path: string, parentMissing: boolean): SourcedAmount {
  const record = asRecord(value, path);
  const source = parseSource(requireKey(record, "source", path), `${path}.source`);
  if (parentMissing) {
    if (source !== "missing" || Object.hasOwn(record, "rupiah")) {
      invalid(`${path} must be missing and must not include rupiah.`);
    }
    rejectUnknown(record, ["source"], path);
    return { source: "missing", rupiah: null };
  }
  if (source === "missing") invalid(`${path}.source must not be missing when the parent source is present.`);
  rejectUnknown(record, ["source", "rupiah"], path);
  return {
    source,
    rupiah: parseRupiah(requireKey(record, "rupiah", path), `${path}.rupiah`),
  };
}

function parsePtkp(value: unknown): StatutoryTable["ptkpAnnual"] {
  const record = asRecord(value, "ptkp_annual");
  rejectUnknown(record, ["source", "amounts"], "ptkp_annual");
  const source = parseSource(requireKey(record, "source", "ptkp_annual"), "ptkp_annual.source");
  const amountsRecord = asRecord(requireKey(record, "amounts", "ptkp_annual"), "ptkp_annual.amounts");
  rejectUnknown(amountsRecord, ptkpStatuses, "ptkp_annual.amounts");
  const amounts = {} as Record<PtkpStatus, SourcedAmount>;
  for (const status of ptkpStatuses) {
    amounts[status] = parseSourcedAmount(
      requireKey(amountsRecord, status, "ptkp_annual.amounts"),
      `ptkp_annual.amounts.${status}`,
      source === "missing",
    );
  }
  return { source, amounts };
}

function parseTerBrackets(value: unknown, path: string, rateScale: bigint): TerBracket[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BRACKETS) {
    invalid(`${path} must contain between 1 and ${MAX_BRACKETS} brackets.`);
  }
  const brackets: TerBracket[] = [];
  let previousUpTo: bigint | null = null;
  let previousRate: bigint | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}.${index}`;
    const entry = asRecord(value[index], itemPath);
    rejectUnknown(entry, ["up_to", "rate_per_scale"], itemPath);
    const upTo = parseUpTo(requireKey(entry, "up_to", itemPath), `${itemPath}.up_to`);
    const ratePerScale = parseSmallInt(
      requireKey(entry, "rate_per_scale", itemPath),
      `${itemPath}.rate_per_scale`,
    );
    if (ratePerScale >= rateScale) {
      invalid(`${itemPath}.rate_per_scale must be below the rate scale.`);
    }
    const isLast = index === value.length - 1;
    if (isLast && upTo !== null) invalid(`${path} must end with an open bracket.`);
    if (!isLast && upTo === null) invalid(`${itemPath}.up_to cannot be open before the last bracket.`);
    if (upTo !== null && previousUpTo !== null && upTo <= previousUpTo) {
      invalid(`${itemPath}.up_to must increase.`);
    }
    if (previousRate !== null && ratePerScale < previousRate) {
      invalid(`${path} rates must not decrease as gross taxable rises.`);
    }
    if (upTo !== null) previousUpTo = upTo;
    previousRate = ratePerScale;
    brackets.push({ upTo, ratePerScale });
  }
  return brackets;
}

function parseTerCategory(
  value: unknown,
  category: TerCategory,
  parentMissing: boolean,
  rateScale: bigint,
): TerCategoryTable {
  const path = `ter.categories.${category}`;
  const record = asRecord(value, path);
  const source = parseSource(requireKey(record, "source", path), `${path}.source`);
  if (parentMissing) {
    if (source !== "missing" || Object.hasOwn(record, "brackets")) {
      invalid(`${path} must be missing and must not include brackets.`);
    }
    rejectUnknown(record, ["source"], path);
    return { source: "missing", brackets: null };
  }
  if (source === "missing") invalid(`${path}.source must not be missing when ter.source is present.`);
  rejectUnknown(record, ["source", "brackets"], path);
  return {
    source,
    brackets: parseTerBrackets(requireKey(record, "brackets", path), `${path}.brackets`, rateScale),
  };
}

function parseTer(value: unknown): StatutoryTable["ter"] {
  const record = asRecord(value, "ter");
  rejectUnknown(record, ["source", "tax_rounding", "rate_scale", "categories"], "ter");
  const source = parseSource(requireKey(record, "source", "ter"), "ter.source");
  if (record.tax_rounding !== "half_up") {
    invalid("ter.tax_rounding must be half_up until a verified example changes it.");
  }
  const rateScale = parseSmallInt(requireKey(record, "rate_scale", "ter"), "ter.rate_scale");
  if (rateScale <= 0n || rateScale > 1_000_000n) invalid("ter.rate_scale is outside the allowed range.");
  const categoriesRecord = asRecord(requireKey(record, "categories", "ter"), "ter.categories");
  rejectUnknown(categoriesRecord, terCategories, "ter.categories");
  const categories = {} as Record<TerCategory, TerCategoryTable>;
  for (const category of terCategories) {
    categories[category] = parseTerCategory(
      requireKey(categoriesRecord, category, "ter.categories"),
      category,
      source === "missing",
      rateScale,
    );
  }
  return { source, taxRounding: "half_up", rateScale, categories };
}

function parseJp(value: unknown): SourcedAmount {
  const record = asRecord(value, "jp_annual_wage_cap");
  const source = parseSource(requireKey(record, "source", "jp_annual_wage_cap"), "jp_annual_wage_cap.source");
  if (source === "missing") {
    if (Object.hasOwn(record, "rupiah")) invalid("jp_annual_wage_cap must not include rupiah while it is missing.");
    rejectUnknown(record, ["source"], "jp_annual_wage_cap");
    return { source: "missing", rupiah: null };
  }
  rejectUnknown(record, ["source", "rupiah"], "jp_annual_wage_cap");
  return {
    source,
    rupiah: parseRupiah(requireKey(record, "rupiah", "jp_annual_wage_cap"), "jp_annual_wage_cap.rupiah"),
  };
}

/** Validates a statutory JSON object. This function does not read the filesystem. */
export function parseStatutoryTable(input: unknown): StatutoryTable {
  const record = asRecord(input, "table");
  const fixture = parseFixture(record);
  const allowed = [
    "schema_version",
    "rule_type",
    "status",
    "effective_from",
    "effective_to",
    "pasal17",
    "biaya_jabatan",
    "ptkp_annual",
    "ter",
    "jp_annual_wage_cap",
  ];
  if (fixture === "synthetic") allowed.push("fixture", "not_official", "note");
  rejectUnknown(record, allowed, "table");
  if (record.schema_version !== 1) invalid("table.schema_version must be 1.");
  if (record.rule_type !== "pph21") invalid("table.rule_type must be pph21.");
  if (record.status !== "draft" && record.status !== "published") {
    invalid("table.status must be draft or published.");
  }
  const effectiveFrom = parseIso(requireKey(record, "effective_from", "table"), "table.effective_from");
  const effectiveTo = parseIso(requireKey(record, "effective_to", "table"), "table.effective_to");
  if (effectiveFrom > effectiveTo) invalid("table.effective_from must be on or before effective_to.");
  const table: StatutoryTable = {
    schemaVersion: 1,
    ruleType: "pph21",
    status: record.status,
    fixture,
    effectiveFrom,
    effectiveTo,
    pasal17: parsePasal17(requireKey(record, "pasal17", "table")),
    biayaJabatan: parseBiaya(requireKey(record, "biaya_jabatan", "table")),
    ptkpAnnual: parsePtkp(requireKey(record, "ptkp_annual", "table")),
    ter: parseTer(requireKey(record, "ter", "table")),
    jpAnnualWageCap: parseJp(requireKey(record, "jp_annual_wage_cap", "table")),
  };
  return deepFreeze(table);
}
