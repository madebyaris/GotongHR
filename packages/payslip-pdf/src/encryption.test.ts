// This file sorts first in `src/*.test.ts`. The opening test is the slice's password check.
import assert from "node:assert/strict";
import test from "node:test";
import { generatePayslipPdf } from "./generate-payslip-pdf.ts";
import {
  passwordRejectionCode,
  PasswordResponses,
  readPayslipText,
} from "./read-payslip-text.test-helper.ts";
import { samplePayslip } from "./sample-payslip.ts";

const PASSWORD = "17081995";

test("a payslip PDF stays closed without the password and opens with it", async () => {
  const payslip = samplePayslip();
  const pdf = await generatePayslipPdf(payslip, PASSWORD);
  const bytes = Buffer.from(pdf);
  const latin = bytes.toString("latin1");

  assert.match(bytes.subarray(0, 8).toString("latin1"), /^%PDF-1\.7/);
  assert.match(latin, /\/AESV3/);
  assert.equal(bytes.includes(Buffer.from(payslip.employeeName)), false);
  assert.equal(bytes.includes(Buffer.from(payslip.employeeNik)), false);
  assert.equal(bytes.includes(Buffer.from("Rp12.345.678")), false);
  assert.equal(bytes.includes(Buffer.from("Rp21.495.678")), false);

  const permissions = latin.match(/\/P (-?\d+)/);
  assert.ok(permissions?.[1], "encryption dictionary keeps a /P entry");
  const flags = Number(permissions[1]);
  assert.equal(flags & 0x8, 0, "modifying is denied");
  assert.equal(flags & 0x20, 0, "annotating is denied");
  assert.equal(flags & 0x10, 0, "copying is denied");
  assert.equal(flags & 0x400, 0, "document assembly is denied");
  assert.notEqual(flags & 0x4, 0, "printing is allowed");
  assert.notEqual(flags & 0x800, 0, "high-resolution printing is allowed");

  assert.equal(PasswordResponses.NEED_PASSWORD, 1);
  assert.equal(PasswordResponses.INCORRECT_PASSWORD, 2);

  await assert.rejects(
    () => readPayslipText(pdf),
    (error: unknown) => passwordRejectionCode(error) === PasswordResponses.NEED_PASSWORD,
  );
  await assert.rejects(
    () => readPayslipText(pdf, "wrong-password"),
    (error: unknown) => passwordRejectionCode(error) === PasswordResponses.INCORRECT_PASSWORD,
  );
  await assert.rejects(
    () => readPayslipText(pdf, "   "),
    (error: unknown) => {
      const code = passwordRejectionCode(error);
      return code === PasswordResponses.NEED_PASSWORD || code === PasswordResponses.INCORRECT_PASSWORD;
    },
  );

  const opened = await readPayslipText(pdf, PASSWORD);
  assert.equal(opened.pageCount, 1);
  const text = opened.text;
  assert.ok(text.includes("PT Sinar Terang Nusantara"));
  assert.ok(text.includes("Sinar Terang Group"));
  assert.ok(text.includes("NPWP 01.234.567.8-012.000"));
  assert.ok(text.includes("Agustus / August 2026"));
  assert.ok(text.includes("SLIP GAJI / PAYSLIP"));
  assert.ok(text.includes("Sari Wulandari"));
  assert.ok(text.includes("**** **** **** 0001"));
  assert.equal(text.includes(payslip.employeeNik), false);
  assert.ok(text.includes("Staff Keuangan"));
  assert.ok(text.includes("TK/0"));
  assert.ok(text.includes("Gross / TER"));
  assert.ok(text.includes("PENGHASILAN / EARNINGS"));
  assert.ok(text.includes("Gaji pokok / Base salary"));
  assert.ok(text.includes("Rp8.500.000"));
  assert.ok(text.includes("Rp12.345.678"));
  assert.ok(text.includes("Jumlah penghasilan / Total earnings"));
  assert.ok(text.includes("Rp22.345.678"));
  assert.ok(text.includes("POTONGAN / DEDUCTIONS"));
  assert.ok(text.includes("PPh 21"));
  assert.ok(text.includes("Rp450.000"));
  assert.ok(text.includes("Jumlah potongan / Total deductions"));
  assert.ok(text.includes("Rp850.000"));
  assert.ok(text.includes("RINCIAN BPJS / BPJS BREAKDOWN"));
  assert.ok(text.includes("Kesehatan / Health"));
  assert.ok(text.includes("Rp400.000"));
  assert.ok(text.includes("Rp54.000"));
  assert.ok(text.includes("Kolom perusahaan tidak dipotong dari gaji bersih."));
  assert.ok(text.includes("The employer column is not deducted from take-home pay."));
  assert.ok(text.includes("DITERIMA / TAKE-HOME PAY"));
  assert.ok(text.includes("Rp21.495.678"));
  assert.ok(text.includes("DRAFT / UNDECLARED STATUTORY TABLE"));
});

test("two payslips with the same user password are not the same bytes", async () => {
  const payslip = samplePayslip();
  const first = await generatePayslipPdf(payslip, PASSWORD);
  const second = await generatePayslipPdf(payslip, PASSWORD);
  assert.notDeepEqual(first, second);
  const opened = await readPayslipText(second, PASSWORD);
  assert.ok(opened.text.includes("Sari Wulandari"));
});
