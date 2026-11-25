import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { rupiah } from "../money.ts";
import {
  buildCoretaxBatch,
  buildCoretaxSlip,
  CoretaxPreflightError,
  CoretaxWithholderError,
  coretaxXsdDirectory,
  findCoretaxXsdFiles,
  formatScaledPercent,
  preflightCoretaxRecords,
  validateCoretaxXml,
  type CoretaxPreflightIssue,
} from "../index.ts";
import { preflightCoretaxRecords as preflightFromSubpath } from "../coretax/index.ts";
import { bpa1, bp21, bp26, bpmp, budiNik, sitiNik, withholder } from "./coretax-fixture.ts";

function count(xml: string, needle: string): number {
  return xml.split(needle).length - 1;
}

function issueFor(issues: readonly CoretaxPreflightIssue[], employeeId: string, field: string): CoretaxPreflightIssue {
  const found = issues.find((issue) => issue.employeeId === employeeId && issue.field === field);
  assert.ok(found, `${employeeId} ${field}`);
  return found;
}

test("the coretax subpath exports the same preflight function", () => {
  assert.equal(preflightFromSubpath, preflightCoretaxRecords);
});

test("package exports coretax and bank-batch subpaths", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, unknown>;
  };
  assert.deepEqual(pkg.exports["./coretax"], {
    types: "./dist/coretax/index.d.ts",
    import: "./dist/coretax/index.js",
  });
  assert.deepEqual(pkg.exports["./bank-batch"], {
    types: "./dist/bank-batch/index.d.ts",
    import: "./dist/bank-batch/index.js",
  });
});

test("scaled percents match the TER scale without floating point", () => {
  assert.equal(formatScaledPercent(200n, 10000n), "2");
  assert.equal(formatScaledPercent(175n, 10000n), "1.75");
  assert.equal(formatScaledPercent(50n, 10000n), "0.5");
  assert.equal(formatScaledPercent(5n, 10000n), "0.05");
  assert.equal(formatScaledPercent(10000n, 10000n), "100");
  assert.equal(formatScaledPercent(10001n, 10000n), null);
  assert.equal(formatScaledPercent(-1n, 10000n), null);
});

test("a bad NIK, NITKU, or PTKP is a preflight row and not a slip", () => {
  const badShort = "123456789012345";
  const badLong = "12345678901234567";
  const badChar = "317401150190000A";
  const result = buildCoretaxBatch({
    slipType: "BPMP",
    withholder,
    records: [
      bpmp({ employeeId: "siti", nik: sitiNik, position: `A&B <C> "D" 'E'`, rate: { ratePerScale: 175n, rateScale: 10000n } }),
      bpmp({ employeeId: "bad-short", nik: badShort }),
      bpmp({ employeeId: "budi", nik: budiNik, name: "Budi Santoso", rate: { ratePerScale: 200n, rateScale: 10000n } }),
      bpmp({ employeeId: "bad-long", nik: badLong }),
      bpmp({ employeeId: "bad-char", nik: badChar }),
      bpmp({ employeeId: "bad-nitku-short", nitku: "010203040506070800000" }),
      bpmp({ employeeId: "bad-nitku-long", nitku: "01020304050607080000011" }),
      bpmp({ employeeId: "bad-nitku-char", nitku: "010203040506070800000X" }),
      bpmp({ employeeId: "bad-ptkp", ptkpStatus: "" }),
      bpmp({ employeeId: "bad-ptkp-code", ptkpStatus: "ZZ/9" }),
    ],
  });

  assert.deepEqual(result.preflight.acceptedEmployeeIds, ["siti", "budi"]);
  assert.ok(result.preflight.rejectedEmployeeIds.includes("bad-short"));
  assert.equal(issueFor(result.preflight.issues, "bad-short", "nik").reason, "NIK must be exactly 16 ASCII digits.");
  assert.equal(issueFor(result.preflight.issues, "bad-long", "nik").reason, "NIK must be exactly 16 ASCII digits.");
  assert.equal(issueFor(result.preflight.issues, "bad-char", "nik").reason, "NIK must be exactly 16 ASCII digits.");
  assert.equal(issueFor(result.preflight.issues, "bad-nitku-short", "nitku").reason, "NITKU must be exactly 22 ASCII digits.");
  assert.equal(issueFor(result.preflight.issues, "bad-nitku-long", "nitku").reason, "NITKU must be exactly 22 ASCII digits.");
  assert.equal(issueFor(result.preflight.issues, "bad-nitku-char", "nitku").reason, "NITKU must be exactly 22 ASCII digits.");
  assert.equal(issueFor(result.preflight.issues, "bad-ptkp", "ptkpStatus").reason, "PTKP status is required.");
  assert.match(issueFor(result.preflight.issues, "bad-ptkp-code", "ptkpStatus").reason, /TK\/0/);

  assert.equal(count(result.xml, "<MmPayroll>"), 2);
  assert.equal(count(result.xml, "</MmPayroll>"), 2);
  assert.ok(result.xml.includes(`<CounterpartTin>${sitiNik}</CounterpartTin>`));
  assert.ok(result.xml.includes(`<CounterpartTin>${budiNik}</CounterpartTin>`));
  assert.equal(count(result.xml, "<CounterpartTin>"), 2);
  for (const secret of [badShort, badLong, badChar, "bad-short", "bad-ptkp", "ZZ/9"]) {
    assert.equal(result.xml.includes(secret), false);
  }
  assert.ok(result.xml.includes("A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;"));
  assert.equal(result.xml.includes("A&B"), false);
  assert.ok(result.xml.includes("<Rate>1.75</Rate>"));
  assert.ok(result.xml.includes("<Rate>2</Rate>"));
  assert.ok(result.xml.includes("<Gross>8000000</Gross>"));
});

test("buildCoretaxSlip throws on a bad NIK and returns no XML", () => {
  assert.throws(
    () => buildCoretaxSlip(withholder, bpmp({ nik: "123" })),
    (error: unknown) => {
      assert.ok(error instanceof CoretaxPreflightError);
      assert.equal(error.issues[0]?.field, "nik");
      assert.equal(error.issues[0]?.reason, "NIK must be exactly 16 ASCII digits.");
      return true;
    },
  );
});

test("a bad withholder throws and does not emit a file", () => {
  assert.throws(
    () => buildCoretaxBatch({ slipType: "BPMP", withholder: { npwp: "123", nitku: withholder.nitku }, records: [bpmp()] }),
    CoretaxWithholderError,
  );
});

test("XML injection in a text field cannot add a slip", () => {
  const payload = "</MmPayroll><CounterpartTin>9999999999999999</CounterpartTin>";
  const xml = buildCoretaxSlip(withholder, bpmp({ position: payload }));
  assert.equal(count(xml, "<MmPayroll>"), 1);
  assert.equal(count(xml, "</MmPayroll>"), 1);
  assert.equal(count(xml, "<CounterpartTin>"), 1);
  assert.ok(xml.includes("&lt;/MmPayroll&gt;&lt;CounterpartTin&gt;9999999999999999&lt;/CounterpartTin&gt;"));
  assert.equal(xml.includes("<CounterpartTin>9999999999999999</CounterpartTin>"), false);
});

test("BP21, BP26, and BPA1 emit their own roots", () => {
  const bp21Xml = buildCoretaxSlip(withholder, bp21());
  assert.ok(bp21Xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`));
  assert.ok(bp21Xml.includes("<Bp21Bulk"));
  assert.ok(bp21Xml.includes("<Deemed>50</Deemed>"));
  assert.ok(bp21Xml.includes(`<CounterpartTin>${sitiNik}</CounterpartTin>`));
  assert.equal(count(bp21Xml, "<Bp21>"), 1);

  const bp26Xml = buildCoretaxSlip(withholder, bp26({ name: `A&B <C>` }));
  assert.ok(bp26Xml.includes("<Bp26Bulk"));
  assert.ok(bp26Xml.includes("<CounterpartName>A&amp;B &lt;C&gt;</CounterpartName>"));
  assert.ok(bp26Xml.includes("<CounterpartCountry>SGP</CounterpartCountry>"));
  assert.ok(bp26Xml.includes("<CounterpartPassport>A1234567</CounterpartPassport>"));
  assert.equal(count(bp26Xml, "<Bp26>"), 1);

  const bpa1Xml = buildCoretaxSlip(withholder, bpa1());
  assert.ok(bpa1Xml.includes("<A1Bulk"));
  assert.ok(bpa1Xml.includes("<TaxableIncome>39000000</TaxableIncome>"));
  assert.ok(bpa1Xml.includes("<IncomeTaxPayable>150000</IncomeTaxPayable>"));
  assert.ok(bpa1Xml.includes("<SlipStatus>FullYear</SlipStatus>"));
  assert.equal(count(bpa1Xml, "<A1>"), 1);
  assert.ok(bpa1Xml.includes(`<StatusTaxExemption>K/1</StatusTaxExemption>`));
});

test("a negative BPA1 payable is a refund amount, and an unrounded PKP is refused", () => {
  const refund = buildCoretaxSlip(
    withholder,
    bpa1({ amounts: { ...bpa1().amounts, incomeTaxPayableIdr: rupiah(-1500n) } }),
  );
  assert.ok(refund.includes("<IncomeTaxPayable>-1500</IncomeTaxPayable>"));

  const refused = buildCoretaxBatch({
    slipType: "BPA1",
    withholder,
    records: [bpa1({ employeeId: "odd-pkp", amounts: { ...bpa1().amounts, taxableIncomeIdr: rupiah(1500n) } })],
  });
  assert.deepEqual(refused.preflight.acceptedEmployeeIds, []);
  assert.equal(issueFor(refused.preflight.issues, "odd-pkp", "taxableIncomeIdr").reason, "PKP must be a multiple of Rp1,000.");
  assert.equal(refused.xml.includes("<A1>"), false);
});

test("a control character is a preflight row and is not written", () => {
  const result = buildCoretaxBatch({
    slipType: "BPMP",
    withholder,
    records: [bpmp({ employeeId: "bad-char", position: "Staff\u0001" }), bpmp({ employeeId: "siti" })],
  });
  assert.deepEqual(result.preflight.rejectedEmployeeIds, ["bad-char"]);
  assert.equal(issueFor(result.preflight.issues, "bad-char", "position").reason, "Position contains a character XML cannot store.");
  assert.equal(result.xml.includes("\u0001"), false);
  assert.equal(count(result.xml, "<MmPayroll>"), 1);
});

test("a batch drops a record of a different slip type", () => {
  const result = buildCoretaxBatch({
    slipType: "BP21",
    withholder,
    records: [bp21(), bpmp({ employeeId: "monthly" })],
  });
  assert.deepEqual(result.preflight.acceptedEmployeeIds, ["siti"]);
  assert.equal(issueFor(result.preflight.issues, "monthly", "slipType").reason, "Slip type must be BP21.");
  assert.equal(count(result.xml, "<Bp21>"), 1);
  assert.equal(result.xml.includes("<MmPayroll>"), false);
});

test("an empty accepted batch is a document with no slips", () => {
  const result = buildCoretaxBatch({ slipType: "BPMP", withholder, records: [] });
  assert.equal(result.preflight.issues.length, 0);
  assert.ok(result.xml.includes("<ListOfMmPayroll>"));
  assert.equal(result.xml.includes("<MmPayroll>"), false);
});

test("a missing passport is nil, and a lone surrogate is not a slip", () => {
  const missing = buildCoretaxBatch({
    slipType: "BPMP",
    withholder,
    records: [bpmp({ passportNumber: undefined as never })],
  });
  assert.deepEqual(missing.preflight.rejectedEmployeeIds, []);
  assert.ok(missing.xml.includes('<CounterpartPassport xsi:nil="true"/>'));
  const emoji = "\u{1F600}";
  const kept = buildCoretaxBatch({
    slipType: "BPMP",
    withholder,
    records: [bpmp({ employeeId: "emoji", position: `Kasir ${emoji}` })],
  });
  assert.equal(count(kept.xml, "<MmPayroll>"), 1);
  assert.ok(kept.xml.includes(emoji));
  const lone = buildCoretaxBatch({
    slipType: "BPMP",
    withholder,
    records: [bpmp({ employeeId: "lone", position: "Staff\uD800" })],
  });
  assert.deepEqual(lone.preflight.rejectedEmployeeIds, ["lone"]);
  assert.equal(lone.xml.includes("\uD800"), false);
  assert.equal(count(lone.xml, "<MmPayroll>"), 0);
});

test("schema lookup matches the slip type and does not use another file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gotong-xsd-"));
  try {
    writeFileSync(path.join(dir, "BP21.xsd"), "<xs:schema/>");
    writeFileSync(path.join(dir, "A1Bulk.xsd"), "<xs:schema/>");
    writeFileSync(path.join(dir, "MmPayrollBulk.xsd"), "<xs:schema/>");
    const missed = validateCoretaxXml({ xml: "<x/>", slipType: "BP26", xsdDirectory: dir });
    assert.deepEqual(missed, { status: "skipped", reason: "xsd missing for BP26" });
    const bpmpResult = validateCoretaxXml({ xml: "<x/>", slipType: "BPMP", xsdDirectory: dir });
    assert.notEqual(bpmpResult.status, "skipped");
    if (bpmpResult.status !== "skipped") assert.equal(bpmpResult.schemaFile, "MmPayrollBulk.xsd");
    const bp21Result = validateCoretaxXml({ xml: "<x/>", slipType: "BP21", xsdDirectory: dir });
    assert.notEqual(bp21Result.status, "skipped");
    if (bp21Result.status !== "skipped") assert.equal(bp21Result.schemaFile, "BP21.xsd");
    const bpa1Result = validateCoretaxXml({ xml: "<x/>", slipType: "BPA1", xsdDirectory: dir });
    assert.notEqual(bpa1Result.status, "skipped");
    if (bpa1Result.status !== "skipped") assert.equal(bpa1Result.schemaFile, "A1Bulk.xsd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("xsd validation skips when no schema file is shipped", (t) => {
  const skipped = validateCoretaxXml({ xml: "<root/>", slipType: "BPMP" });
  assert.deepEqual(skipped, { status: "skipped", reason: "xsd missing" });
  assert.equal(findCoretaxXsdFiles(coretaxXsdDirectory).length, 0);
  if (skipped.status === "skipped") {
    process.stdout.write("xsd missing\n");
    t.skip("xsd missing");
    return;
  }
});
