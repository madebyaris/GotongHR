import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  InvalidStatutoryTableError,
  findTableForDate,
  isStatutoryDeclared,
  jpAnnualWageCap,
  parseStatutoryTable,
} from "../index.ts";
import { id2026DraftTable } from "../tables/draft-2026.ts";
import { loadSyntheticFixture, readJson } from "./fixture-table.ts";

function labelSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(labelSources);
  if (typeof value !== "object" || value === null) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    next[key] = key === "source" && child === "synthetic" ? "worked-example" : labelSources(child);
  }
  return next;
}

test("the 2026 draft parses and stays inside its effective window", () => {
  assert.equal(id2026DraftTable.status, "draft");
  assert.equal(id2026DraftTable.fixture, null);
  assert.equal(id2026DraftTable.effectiveFrom, "2026-01-01");
  assert.equal(id2026DraftTable.effectiveTo, "2026-12-31");
  assert.equal(id2026DraftTable.pasal17.pkpRoundDownTo, 1000n);
  assert.equal(isStatutoryDeclared(id2026DraftTable), false);
});

test("the synthetic fixture is labeled and is not a declared statutory file", () => {
  const raw = readJson("./fixtures/synthetic-pph21.json") as { fixture?: string; not_official?: boolean };
  assert.equal(raw.fixture, "synthetic");
  assert.equal(raw.not_official, true);
  const table = loadSyntheticFixture();
  assert.equal(table.fixture, "synthetic");
  assert.equal(isStatutoryDeclared(table), false);
  assert.equal(table.pasal17.bands.length, id2026DraftTable.pasal17.bands.length);
  for (let index = 0; index < table.pasal17.bands.length; index += 1) {
    assert.equal(table.pasal17.bands[index]?.upTo, id2026DraftTable.pasal17.bands[index]?.upTo);
    assert.equal(
      table.pasal17.bands[index]?.ratePerScale,
      id2026DraftTable.pasal17.bands[index]?.ratePerScale,
    );
  }
});

test("a published non-fixture table with rates is declared present", () => {
  const copy = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as Record<string, unknown>;
  delete copy.fixture;
  delete copy.not_official;
  delete copy.note;
  copy.status = "published";
  assert.throws(() => parseStatutoryTable(copy), /cannot be synthetic/);

  const labeled = labelSources(copy) as Record<string, unknown>;
  assert.equal(isStatutoryDeclared(parseStatutoryTable(labeled)), true);
  labeled.status = "draft";
  assert.equal(isStatutoryDeclared(parseStatutoryTable(labeled)), false);

  const missingJp = structuredClone(labeled) as Record<string, unknown>;
  missingJp.status = "published";
  missingJp.jp_annual_wage_cap = { source: "missing" };
  assert.equal(isStatutoryDeclared(parseStatutoryTable(missingJp)), false);
});

test("the JP cap on the synthetic fixture is the labeled stand-in, not a guessed statute", () => {
  assert.equal(jpAnnualWageCap(loadSyntheticFixture()), 123456789n);
});

test("findTableForDate uses the injected date and rejects overlap or a gap", () => {
  const current = loadSyntheticFixture();
  const prior = parseStatutoryTable({
    ...(readJson("./fixtures/synthetic-pph21.json") as Record<string, unknown>),
    effective_from: "2025-01-01",
    effective_to: "2025-12-31",
  });
  assert.equal(findTableForDate([prior, current], { year: 2026, month: 6, day: 15 }), current);
  assert.equal(findTableForDate([current], { year: 2026, month: 1, day: 1 }), current);
  assert.equal(findTableForDate([current], { year: 2026, month: 12, day: 31 }), current);
  assert.throws(
    () => findTableForDate([current], { year: 2025, month: 12, day: 31 }),
    /No statutory table covers 2025-12-31/,
  );
  assert.throws(
    () => findTableForDate([current, current], { year: 2026, month: 6, day: 1 }),
    /Overlapping statutory tables/,
  );
  assert.throws(
    () => findTableForDate([id2026DraftTable], { year: 2026, month: 6, day: 15 }),
    /draft statutory table/,
  );
  assert.equal(
    findTableForDate([id2026DraftTable], { year: 2026, month: 6, day: 15 }, { allowUndeclared: true }),
    id2026DraftTable,
  );
});

test("the loader rejects a guessed TER rate hidden in a missing category", () => {
  const copy = structuredClone(readJson("../tables/id-2026.draft.json")) as Record<string, unknown>;
  const ter = copy.ter as { categories: { A: Record<string, unknown> } };
  ter.categories.A = {
    source: "missing",
    brackets: [{ up_to: null, rate_per_scale: 200 }],
  };
  assert.throws(() => parseStatutoryTable(copy), InvalidStatutoryTableError);
});

test("the loader rejects PTKP rupiah and a numeric JP cap while the source is missing", () => {
  const ptkp = structuredClone(readJson("../tables/id-2026.draft.json")) as Record<string, unknown>;
  const amounts = (ptkp.ptkp_annual as { amounts: { "TK/0": Record<string, unknown> } }).amounts;
  amounts["TK/0"] = { source: "missing", rupiah: "54000000" };
  assert.throws(() => parseStatutoryTable(ptkp), InvalidStatutoryTableError);

  const cap = structuredClone(readJson("../tables/id-2026.draft.json")) as Record<string, unknown>;
  cap.jp_annual_wage_cap = { source: "missing", rupiah: "100000000" };
  assert.throws(() => parseStatutoryTable(cap), InvalidStatutoryTableError);
});

test("the loader rejects decreasing TER rates and money typed as a JSON number", () => {
  assert.throws(
    () =>
      parseStatutoryTable({
        ...(readJson("./fixtures/synthetic-pph21.json") as Record<string, unknown>),
        ter: {
          source: "synthetic",
          tax_rounding: "half_up",
          rate_scale: 10000,
          categories: {
            A: {
              source: "synthetic",
              brackets: [
                { up_to: "1000000", rate_per_scale: 400 },
                { up_to: null, rate_per_scale: 200 },
              ],
            },
            B: {
              source: "synthetic",
              brackets: [{ up_to: null, rate_per_scale: 200 }],
            },
            C: {
              source: "synthetic",
              brackets: [{ up_to: null, rate_per_scale: 200 }],
            },
          },
        },
      }),
    /must not decrease/,
  );

  const money = structuredClone(readJson("../tables/id-2026.draft.json")) as Record<string, unknown>;
  (money.biaya_jabatan as { monthly_cap: unknown }).monthly_cap = 500000;
  assert.throws(() => parseStatutoryTable(money), /integer string/);
});

test("the loader rejects a missing statutory source, a decreasing Pasal 17 rate, and an inexact rupiah", () => {
  const missingPasal = structuredClone(readJson("../tables/id-2026.draft.json")) as {
    pasal17: { source: string };
  };
  missingPasal.pasal17.source = "missing";
  assert.throws(() => parseStatutoryTable(missingPasal), /pasal17.source cannot be missing/);

  const missingBiaya = structuredClone(readJson("../tables/id-2026.draft.json")) as {
    biaya_jabatan: { source: string };
  };
  missingBiaya.biaya_jabatan.source = "missing";
  assert.throws(() => parseStatutoryTable(missingBiaya), /biaya_jabatan.source cannot be missing/);

  const decreasing = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as {
    pasal17: { bands: Array<{ rate_per_scale: number }> };
  };
  const lower = decreasing.pasal17.bands[1];
  assert.ok(lower);
  lower.rate_per_scale = 100;
  assert.throws(() => parseStatutoryTable(decreasing), /must not decrease/);

  const inexact = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as {
    pasal17: { bands: Array<{ rate_per_scale: number; rate_scale: number }> };
  };
  const first = inexact.pasal17.bands[0];
  assert.ok(first);
  first.rate_per_scale = 1;
  first.rate_scale = 3;
  assert.throws(() => parseStatutoryTable(inexact), /whole rupiah/);
});

test("the shipped draft file is the one the package exports", () => {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL("../tables/id-2026.draft.json", import.meta.url)), "utf8"),
  );
  assert.deepEqual(parseStatutoryTable(raw), id2026DraftTable);
});
