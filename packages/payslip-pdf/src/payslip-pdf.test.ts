import assert from "node:assert/strict";
import test from "node:test";
import { bilingual, formatIdr, formatPayslipPeriod, maskNik } from "./format.ts";
import { generatePayslipPdf } from "./generate-payslip-pdf.ts";
import { passwordFromDateOfBirth, resolvePayslipPassword } from "./password.ts";
import { readPayslipText } from "./read-payslip-text.test-helper.ts";
import { samplePayslip } from "./sample-payslip.ts";

test("the default password is the date of birth as ddMMyyyy", () => {
  assert.equal(passwordFromDateOfBirth("1995-08-17"), "17081995");
  assert.equal(passwordFromDateOfBirth("2000-02-29"), "29022000");
  assert.equal(passwordFromDateOfBirth("2000-01-02"), "02012000");
  assert.equal(passwordFromDateOfBirth("0099-01-02"), "02010099");
  assert.equal(passwordFromDateOfBirth("0004-02-29"), "29020004");
  assert.equal(passwordFromDateOfBirth("0000-02-29"), "29020000");
  assert.throws(() => passwordFromDateOfBirth("0099-02-29"), /real calendar day/);
  assert.throws(() => passwordFromDateOfBirth("0100-02-29"), /real calendar day/);
  assert.throws(() => passwordFromDateOfBirth("1995-02-31"), /real calendar day/);
  assert.throws(() => passwordFromDateOfBirth("1900-02-29"), /real calendar day/);
  assert.throws(() => passwordFromDateOfBirth("17-08-1995"), /YYYY-MM-DD/);
  assert.throws(() => passwordFromDateOfBirth("1995-08-17T00:00:00Z"), /YYYY-MM-DD/);
  assert.throws(() => passwordFromDateOfBirth(" 1995-08-17"), /YYYY-MM-DD/);
});

test("a tenant override is passed through and a blank override is rejected", () => {
  assert.equal(
    resolvePayslipPassword({ dateOfBirth: "1995-08-17", tenantOverride: "Rahasia-1" }),
    "Rahasia-1",
  );
  assert.equal(
    resolvePayslipPassword({ dateOfBirth: "not-a-date", tenantOverride: "a b" }),
    "a b",
  );
  assert.equal(
    resolvePayslipPassword({ dateOfBirth: "1995-08-17", tenantOverride: "  ab  " }),
    "  ab  ",
  );
  assert.equal(resolvePayslipPassword({ dateOfBirth: "1995-08-17", tenantOverride: null }), "17081995");
  assert.equal(resolvePayslipPassword({ dateOfBirth: "1995-08-17" }), "17081995");
  assert.throws(
    () => resolvePayslipPassword({ dateOfBirth: "1995-08-17", tenantOverride: "   " }),
    /non-whitespace/,
  );
  assert.throws(
    () => resolvePayslipPassword({ dateOfBirth: "1995-08-17", tenantOverride: "" }),
    /non-whitespace/,
  );
  assert.throws(
    () => resolvePayslipPassword({ dateOfBirth: "1995-02-31", tenantOverride: null }),
    /real calendar day/,
  );
});

test("an empty password never produces a PDF", () => {
  const payslip = samplePayslip();
  for (const password of ["", " ", "   ", "\n", "\t"]) {
    assert.throws(() => generatePayslipPdf(payslip, password), /non-whitespace/);
  }
});

test("idr formatting, NIK masking, and period labels", () => {
  assert.equal(formatIdr(12_345_678n), "Rp12.345.678");
  assert.equal(formatIdr(0n), "Rp0");
  assert.equal(formatIdr(850_000n), "Rp850.000");
  assert.equal(formatIdr(-1_500n), "-Rp1.500");
  assert.equal(maskNik("3174091708950001"), "**** **** **** 0001");
  assert.equal(maskNik("3174 0917 0895 0001"), "**** **** **** 0001");
  assert.throws(() => maskNik("123"), /16 digits/);
  assert.equal(formatPayslipPeriod(2026, 8), "Agustus / August 2026");
  assert.equal(formatPayslipPeriod(2026, 11), "November 2026");
  assert.equal(bilingual("Bonus", "Bonus"), "Bonus");
  assert.equal(bilingual("Gaji pokok", "Base salary"), "Gaji pokok / Base salary");
});

test("the date-of-birth password opens the PDF", async () => {
  const password = resolvePayslipPassword({ dateOfBirth: "1995-08-17" });
  const pdf = await generatePayslipPdf(samplePayslip(), password);
  const opened = await readPayslipText(pdf, password);
  assert.ok(opened.text.includes("Sari Wulandari"));
  assert.equal(password, "17081995");
});

test("a tenant password opens the PDF and a published table has no watermark", async () => {
  const password = resolvePayslipPassword({
    dateOfBirth: "1995-08-17",
    tenantOverride: "Rahasia-1",
  });
  const pdf = await generatePayslipPdf(samplePayslip({ tableUndeclared: false }), password);
  const opened = await readPayslipText(pdf, password);
  assert.ok(opened.text.includes("Sari Wulandari"));
  assert.equal(opened.text.includes("DRAFT / UNDECLARED STATUTORY TABLE"), false);
  await assert.rejects(() => readPayslipText(pdf, "17081995"));
});

test("take-home pay is the amount on the payslip, not a sum computed here", async () => {
  const pdf = await generatePayslipPdf(samplePayslip({ netPayIdr: 1n }), "17081995");
  const opened = await readPayslipText(pdf, "17081995");
  const lines = opened.text.split("\n");
  assert.ok(lines.includes("Rp1"));
  assert.ok(lines.includes("Rp22.345.678"));
  assert.equal(lines.includes("Rp21.495.678"), false);
});

test("a long earning label wraps beside the amount instead of through it", async () => {
  const labelId =
    "Tunjangan transportasi lintas kota untuk penugasan proyek yang berlangsung beberapa bulan";
  const labelEn =
    "Cross-city transport allowance for a project assignment that runs for several months";
  const fullLabel = `${labelId} / ${labelEn}`;
  const payslip = samplePayslip();
  payslip.earnings = [{ labelId, labelEn, amountIdr: 8_765_432n }, ...payslip.earnings];
  const opened = await readPayslipText(await generatePayslipPdf(payslip, "17081995"), "17081995");
  assert.ok(opened.text.includes(labelId));
  assert.ok(opened.text.includes(labelEn));
  const amount = opened.runs.find((run) => run.str === "Rp8.765.432");
  assert.ok(amount);
  const labelRuns = opened.runs.filter((run) => run.str.length > 8 && fullLabel.includes(run.str));
  assert.ok(labelRuns.length >= 2, "the long label wraps onto more than one line");
  for (const run of labelRuns) {
    assert.ok(
      run.x + run.width <= amount.x + 0.5,
      `"${run.str}" ends at ${run.x + run.width} and the amount starts at ${amount.x}`,
    );
  }
  const lowestLabel = Math.min(...labelRuns.map((run) => run.y));
  const salary = opened.runs.find((run) => run.str.includes("Gaji pokok"));
  assert.ok(salary);
  assert.ok(salary.y < lowestLabel - 2);
});

test("the BPJS notes sit on two separate lines", async () => {
  const opened = await readPayslipText(await generatePayslipPdf(samplePayslip(), "17081995"), "17081995");
  const indonesian = opened.runs.find((run) => run.str.includes("Kolom perusahaan"));
  const english = opened.runs.find((run) => run.str.includes("The employer column"));
  assert.ok(indonesian);
  assert.ok(english);
  assert.equal(indonesian.x, english.x);
  assert.ok(
    english.y < indonesian.y - 4,
    `english y ${english.y} overlaps indonesian y ${indonesian.y}`,
  );
});

test("the generator rejects a payslip that is not ready to print", () => {
  const payslip = samplePayslip();
  assert.throws(() => generatePayslipPdf({ ...payslip, employeeName: "  " }, "17081995"), /Employee name/);
  assert.throws(() => generatePayslipPdf({ ...payslip, periodMonth: 13 }, "17081995"), /Period month/);
  assert.throws(
    () => generatePayslipPdf({ ...payslip, pph21Method: "grossup" as "gross" }, "17081995"),
    /PPh 21 method/,
  );
  assert.throws(
    () => generatePayslipPdf({ ...payslip, netPayIdr: 10 as unknown as bigint }, "17081995"),
    /Net pay/,
  );
  assert.throws(
    () => generatePayslipPdf({ ...payslip, tableUndeclared: "yes" as unknown as boolean }, "17081995"),
    /tableUndeclared/,
  );
});
