import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ptkpStatuses } from "@gotonghr/contracts";
import {
  MissingStatutoryValueError,
  PayrollInputError,
  applyScaledRate,
  biayaJabatan,
  calculateMonthlyPph21,
  civilDate,
  civilDateFromIso,
  jpAnnualWageCap,
  parseStatutoryTable,
  pasal17Tax,
  reconcilePph21,
  roundPkpDown,
  rupiah,
  terCategoryForPtkp,
  terRate,
} from "../index.ts";
import { id2026DraftTable } from "../tables/draft-2026.ts";
import { components, loadSyntheticFixture, readJson } from "./fixture-table.ts";

const categoryByStatus = {
  "TK/0": "A",
  "TK/1": "A",
  "K/0": "A",
  "TK/2": "B",
  "TK/3": "B",
  "K/1": "B",
  "K/2": "B",
  "K/3": "C",
} as const;

test("PTKP statuses map to TER categories A, B, and C", () => {
  assert.deepEqual(ptkpStatuses, ["TK/0", "TK/1", "TK/2", "TK/3", "K/0", "K/1", "K/2", "K/3"]);
  for (const status of ptkpStatuses) {
    assert.equal(terCategoryForPtkp(status), categoryByStatus[status]);
  }
  assert.throws(() => terCategoryForPtkp("ZZ" as never), PayrollInputError);
});

test("the 2026 draft keeps TER percentages, PTKP rupiah, and the JP cap missing", () => {
  assert.equal(id2026DraftTable.ter.source, "missing");
  assert.equal(id2026DraftTable.ptkpAnnual.source, "missing");
  assert.equal(id2026DraftTable.jpAnnualWageCap.kind, "missing");
  for (const category of ["A", "B", "C"] as const) {
    assert.equal(id2026DraftTable.ter.categories[category].kind, "missing");
  }
  for (const status of ptkpStatuses) {
    assert.equal(id2026DraftTable.ptkpAnnual.amounts[status].kind, "missing");
  }
  assert.throws(() => jpAnnualWageCap(id2026DraftTable), MissingStatutoryValueError);
});

test("Pasal 17 bands and biaya jabatan on the draft match the architecture spec", () => {
  assert.deepEqual(
    id2026DraftTable.pasal17.bands.map((band) => ({
      upTo: band.upTo,
      ratePerScale: band.ratePerScale,
      rateScale: band.rateScale,
    })),
    [
      { upTo: 60_000_000n, ratePerScale: 500n, rateScale: 10000n },
      { upTo: 250_000_000n, ratePerScale: 1500n, rateScale: 10000n },
      { upTo: 500_000_000n, ratePerScale: 2500n, rateScale: 10000n },
      { upTo: 5_000_000_000n, ratePerScale: 3000n, rateScale: 10000n },
      { upTo: null, ratePerScale: 3500n, rateScale: 10000n },
    ],
  );
  assert.equal(id2026DraftTable.biayaJabatan.ratePerScale, 500n);
  assert.equal(id2026DraftTable.biayaJabatan.rateScale, 10000n);
  assert.equal(id2026DraftTable.biayaJabatan.monthlyCap, 500_000n);
  assert.equal(id2026DraftTable.biayaJabatan.rounding, "floor");
  assert.equal(id2026DraftTable.ter.taxRounding, "half_up");
  assert.equal(id2026DraftTable.pasal17.source, "uu-hpp-pasal-17");
  assert.equal(id2026DraftTable.biayaJabatan.source, "pmk-biaya-jabatan");
});

test("Pasal 17 tax is exact at the spec band boundaries", () => {
  const cases: Array<[bigint, bigint]> = [
    [0n, 0n],
    [60_000_000n, 3_000_000n],
    [60_001_000n, 3_000_150n],
    [250_000_000n, 31_500_000n],
    [250_001_000n, 31_500_250n],
    [500_000_000n, 94_000_000n],
    [500_001_000n, 94_000_300n],
    [5_000_000_000n, 1_444_000_000n],
    [5_000_001_000n, 1_444_000_350n],
  ];
  for (const [pkp, tax] of cases) {
    assert.equal(pasal17Tax(id2026DraftTable, pkp), tax);
  }
  assert.equal(roundPkpDown(1_250_999n), 1_250_000n);
  assert.equal(roundPkpDown(999n), 0n);
  assert.throws(() => pasal17Tax(id2026DraftTable, 1_250_999n), /Rp1,000/);
  assert.throws(
    () => pasal17Tax({ ...id2026DraftTable, pasal17: { ...id2026DraftTable.pasal17, bands: [] } }, 0n),
    /open band/,
  );
  const closed = id2026DraftTable.pasal17.bands.map((band, index, all) =>
    index === all.length - 1 ? { ...band, upTo: 9_000_000_000n } : band,
  );
  assert.throws(
    () =>
      pasal17Tax({ ...id2026DraftTable, pasal17: { ...id2026DraftTable.pasal17, bands: closed } }, 0n),
    /open band/,
  );
});

test("biaya jabatan floors 5 percent and applies the monthly cap", () => {
  const inspect = { allowUndeclared: true } as const;
  assert.equal(biayaJabatan(id2026DraftTable, 12_000_000n, 12, inspect), 600_000n);
  assert.equal(biayaJabatan(id2026DraftTable, 200_000_000n, 12, inspect), 6_000_000n);
  assert.equal(biayaJabatan(id2026DraftTable, 100_000_000n, 3, inspect), 1_500_000n);
  assert.equal(biayaJabatan(id2026DraftTable, 19n, 1, inspect), 0n);
  assert.throws(() => biayaJabatan(id2026DraftTable, 1n, 0, inspect), PayrollInputError);
  assert.throws(() => biayaJabatan(id2026DraftTable, 1n, 13, inspect), PayrollInputError);
  assert.throws(() => biayaJabatan(id2026DraftTable, 12_000_000n, 12), /draft statutory table/);
});

test("half-up rounding stays on integer rupiah, including above the safe integer limit", () => {
  assert.equal(applyScaledRate(1n, 5000n, 10000n, "half_up"), 1n);
  assert.equal(applyScaledRate(1n, 4999n, 10000n, "half_up"), 0n);
  assert.equal(applyScaledRate(1n, 5000n, 10000n, "floor"), 0n);
  const amount = 9007199254740993n;
  assert.ok(amount > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(applyScaledRate(amount, 1n, 1n, "floor"), amount);
  assert.throws(
    () => applyScaledRate(1n, -1n, 0n, "floor"),
    /ratePerScale must be a non-negative integer and rateScale must be a positive integer/,
  );
  assert.throws(() => applyScaledRate(1n, 1n, 2n, "up" as "floor"), /rounding must be/);
});

test("monthly TER on the draft throws instead of inventing a rate", () => {
  assert.throws(
    () =>
      calculateMonthlyPph21({
        payrollDate: civilDate(2026, 1, 31),
        periodMonth: 1,
        table: id2026DraftTable,
        ptkpStatus: "TK/0",
        method: "gross",
        components: components(5_000_000n),
      }),
    /draft statutory table/,
  );
  const published = structuredClone(readJson("../tables/id-2026.draft.json")) as Record<string, unknown>;
  published.status = "published";
  assert.throws(
    () =>
      calculateMonthlyPph21({
        payrollDate: civilDate(2026, 1, 31),
        periodMonth: 1,
        table: parseStatutoryTable(published),
        ptkpStatus: "TK/0",
        method: "gross",
        components: components(5_000_000n),
      }),
    (error: unknown) => {
      assert.ok(error instanceof MissingStatutoryValueError);
      assert.equal(error.key, "ter.A");
      assert.doesNotMatch(error.message, /%/);
      return true;
    },
  );
});

test("December reconciliation refuses the undeclared draft", () => {
  assert.throws(
    () =>
      reconcilePph21({
        payrollDate: civilDate(2026, 12, 31),
        reason: "december",
        table: id2026DraftTable,
        ptkpStatus: "K/1",
        activeMonths: 12,
        ytdGrossTaxable: rupiah(60_000_000n),
        ytdEmployeeJht: rupiah(0n),
        ytdEmployeeJp: rupiah(0n),
        verifiedZakat: rupiah(0n),
        ytdPph21Withheld: rupiah(0n),
      }),
    /draft statutory table/,
  );
});

test("December reconciliation throws instead of inventing a missing PTKP", () => {
  const raw = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as Record<string, unknown>;
  const amounts: Record<string, { source: string }> = {};
  for (const status of ptkpStatuses) amounts[status] = { source: "missing" };
  raw.ptkp_annual = { source: "missing", amounts };
  assert.throws(
    () =>
      reconcilePph21({
        payrollDate: civilDate(2026, 12, 31),
        reason: "december",
        table: parseStatutoryTable(raw),
        ptkpStatus: "K/1",
        activeMonths: 12,
        ytdGrossTaxable: rupiah(60_000_000n),
        ytdEmployeeJht: rupiah(0n),
        ytdEmployeeJp: rupiah(0n),
        verifiedZakat: rupiah(0n),
        ytdPph21Withheld: rupiah(0n),
      }),
    (error: unknown) => {
      assert.ok(error instanceof MissingStatutoryValueError);
      assert.equal(error.key, "ptkp_annual.K/1");
      return true;
    },
  );
});

test("a numeric TER case on the shipped table is skipped while rates are missing", (t) => {
  if (id2026DraftTable.ter.source === "missing") {
    t.skip("TER rates are missing on id-2026.draft.json");
    return;
  }
  let previous = 0n;
  let gross = 0n;
  for (let step = 0; step < 12; step += 1) {
    const rate = terRate(id2026DraftTable, "A", gross).ratePerScale;
    assert.ok(rate >= previous);
    previous = rate;
    gross = gross === 0n ? 1_000_000n : gross * 2n;
  }
});

test("a numeric PTKP case on the shipped table is skipped while amounts are missing", (t) => {
  const tk0 = id2026DraftTable.ptkpAnnual.amounts["TK/0"];
  if (tk0.kind !== "present") {
    t.skip("PTKP rupiah amounts are missing on id-2026.draft.json");
    return;
  }
  const result = reconcilePph21({
    payrollDate: civilDate(2026, 12, 31),
    reason: "december",
    table: id2026DraftTable,
    ptkpStatus: "TK/0",
    activeMonths: 12,
    ytdGrossTaxable: rupiah(0n),
    ytdEmployeeJht: rupiah(0n),
    ytdEmployeeJp: rupiah(0n),
    verifiedZakat: rupiah(0n),
    ytdPph21Withheld: rupiah(0n),
  });
  assert.equal(result.ptkp, tk0.rupiah);
});

function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      out += char;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      if (char === "\n") out += char;
      index += 1;
      continue;
    }
    out += char;
    if (char === "\\" && next !== undefined) {
      out += next;
      index += 2;
      continue;
    }
    if (
      (state === "single" && char === "'") ||
      (state === "double" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
    index += 1;
  }
  return out;
}

test("calculation sources do not touch IO, clocks, or floating currency", () => {
  const sample = 'const label = "keep // 1.5 inside";\n// 9.9\nexport const kept = 1;\n';
  const strippedSample = stripComments(sample);
  assert.match(strippedSample, /keep \/\/ 1\.5 inside/);
  assert.doesNotMatch(strippedSample, /9\.9/);
  assert.match(strippedSample, /export const kept/);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) files.push(full);
    }
  };
  walk(root);
  const banned: Array<[RegExp, string]> = [
    [/\bnode:fs\b/, "node:fs"],
    [/\bnode:http\b/, "node:http"],
    [/\bnode:https\b/, "node:https"],
    [/\bnode:net\b/, "node:net"],
    [/\bdrizzle-orm\b/, "drizzle-orm"],
    [/\bfastify\b/, "fastify"],
    [/@aws-sdk\b/, "@aws-sdk"],
    [/\bfrom\s+["']pg["']/, "pg"],
    [/\bDate\.now\b/, "Date.now"],
    [/\bnew Date\b/, "new Date"],
    [/\bMath\./, "Math"],
    [/\bNumber\(/, "Number("],
    [/\bparseFloat\b/, "parseFloat"],
    [/\bparseInt\b/, "parseInt"],
    [/\bprocess\.env\b/, "process.env"],
    [/\bfetch\(/, "fetch("],
    [/\d+\.\d+/, "decimal literal"],
  ];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    const relative = path.relative(root, file);
    assert.match(source, /\bexport\b/, `${relative} stripped to empty`);
    if (relative !== path.join("tables", "draft-2026.ts")) {
      assert.equal(source.includes("id-2026.draft.json"), false, relative);
    }
    for (const [pattern, label] of banned) {
      // coretax/xsd.ts reads local schema files when a pilot adds them. It does not call DJP.
      if (relative === path.join("coretax", "xsd.ts") && label === "node:fs") continue;
      assert.equal(pattern.test(source), false, `${relative} contains ${label}`);
    }
  }
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const bannedName of ["drizzle-orm", "pg", "postgres", "fastify"]) {
    assert.equal(names.includes(bannedName), false);
  }
});

test("civil dates reject impossible days and do not use the clock", () => {
  assert.equal(civilDate(2024, 2, 29).day, 29);
  assert.throws(() => civilDate(2026, 2, 29), PayrollInputError);
  assert.throws(() => civilDateFromIso("2026-02-30"), /real calendar date/);
  assert.throws(() => civilDateFromIso("20260230"), /YYYY-MM-DD/);
  assert.throws(() => civilDate(2026, 13, 1), PayrollInputError);
  const table = loadSyntheticFixture();
  assert.equal(table.effectiveFrom <= "2026-06-15" && "2026-06-15" <= table.effectiveTo, true);
});
