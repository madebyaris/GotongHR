import assert from "node:assert/strict";
import test from "node:test";
import { rupiah } from "../money.ts";
import { BankBatchInputError, bankBatchIds, formatBankBatch, verifyBankBatch } from "../index.ts";
import { verifyBankBatch as verifyFromSubpath } from "../bank-batch/index.ts";
import {
  firstAmount,
  increaseDetailAmount,
  increaseHeaderTotal,
  secondAmount,
  twoEmployeeBatch,
  twoEmployeeTotal,
} from "./bank-fixture.ts";

test("the bank-batch subpath exports the same verifier", () => {
  assert.equal(verifyFromSubpath, verifyBankBatch);
});

test("each bank header total is the sum of two detail rows", () => {
  for (const bank of bankBatchIds) {
    const file = formatBankBatch(bank, twoEmployeeBatch());
    assert.equal(file.bank, bank);
    assert.equal(file.detailCount, 2);
    assert.equal(file.excluded.length, 0);
    assert.equal(file.totalIdr, twoEmployeeTotal);
    assert.equal(file.body.includes("\n") && !file.body.includes("\r\n"), false);
    const verification = verifyBankBatch(bank, file.body);
    assert.equal(verification.ok, true, bank);
    assert.equal(verification.headerTotalIdr, twoEmployeeTotal);
    assert.equal(verification.detailTotalIdr, twoEmployeeTotal);
    assert.equal(verification.headerTotalIdr, verification.detailTotalIdr);

    const detailTamper = verifyBankBatch(bank, increaseDetailAmount(file.body, firstAmount));
    assert.equal(detailTamper.ok, false, bank);
    assert.equal(detailTamper.detailTotalIdr - detailTamper.headerTotalIdr, 1n);
    assert.equal(detailTamper.reason, "Header total does not match the sum of detail amounts.");

    const headerTamper = verifyBankBatch(bank, increaseHeaderTotal(file.body));
    assert.equal(headerTamper.ok, false, bank);
    assert.equal(headerTamper.headerTotalIdr - headerTamper.detailTotalIdr, 1n);
    assert.equal(headerTamper.reason, "Header total does not match the sum of detail amounts.");
  }
});

test("BCA, BNI, BRI, and Mandiri rows use their control layouts", () => {
  const bca = formatBankBatch("bca-klikbisnis", twoEmployeeBatch());
  const bcaLines = bca.body.split("\r\n").filter((line) => line.length > 0);
  assert.equal(bcaLines[0], "H,BCA_KLIKBISNIS,20260115,3333333333,2,3500000");
  assert.equal(bcaLines[1], "D,1111111111,Siti Aminah,1000000,GAJI JAN,siti@example.com");
  assert.equal(bcaLines[2], "D,2222222222,Budi Santoso,2500000,GAJI JAN,");

  const bni = formatBankBatch("bni-direct", twoEmployeeBatch()).body.split("\r\n");
  assert.equal(bni[0], "H,BNI_DIRECT,20260115,3333333333,2,3500000");
  assert.equal(bni[1], "D,1111111111,Siti Aminah,1000000,GAJI JAN,009");

  const bri = formatBankBatch("bri-qlola", twoEmployeeBatch()).body.split("\r\n");
  assert.equal(bri[0], "H,BRI_QLOLA,20260115,3333333333,2,3500000");
  assert.equal(bri[2], "D,2222222222,Budi Santoso,2500000,GAJI JAN,");

  const mandiriLines = formatBankBatch("mandiri-kopra", twoEmployeeBatch()).body.split("\r\n");
  assert.equal(mandiriLines[0], "P,20260115,3333333333,2,3500000.00");
  const detail = mandiriLines[1]?.split(",") ?? [];
  assert.equal(detail.length, 41);
  assert.equal(detail[0], "1111111111");
  assert.equal(detail[1], "Siti Aminah");
  assert.equal(detail[5], "IDR");
  assert.equal(detail[6], "1000000.00");
  assert.equal(detail[9], "IBU");
  assert.equal(detail[16], "Y");
  assert.equal(detail[17], "siti@example.com");
  assert.equal(secondAmount, 2_500_000n);
});

test("names and accounts cannot break the row or start a formula", () => {
  const input = twoEmployeeBatch();
  const first = input.payments[0];
  const second = input.payments[1];
  assert.ok(first);
  assert.ok(second);
  const file = formatBankBatch("bca-klikbisnis", {
    ...input,
    payments: [
      {
        ...first,
        accountName: `=Andi\nSantoso, "A"`,
        accountNumber: "12-34 567890",
      },
      {
        ...second,
        accountNumber: "00-1234-5678",
      },
      {
        employeeId: "excluded",
        accountNumber: "ABC1234567",
        accountName: "Excluded",
        amountIdr: rupiah(888_888_888n),
        remark: "NO",
      },
    ],
  });
  assert.equal(file.detailCount, 2);
  assert.equal(file.totalIdr, twoEmployeeTotal);
  assert.equal(file.excluded.length, 1);
  assert.equal(file.excluded[0]?.field, "accountNumber");
  assert.equal(file.body.includes("888888888"), false);
  assert.equal(file.body.includes("ABC1234567"), false);
  assert.ok(file.body.includes("'=Andi Santoso A"));
  assert.ok(file.body.includes("1234567890"));
  assert.ok(file.body.includes("0012345678"));
  assert.equal(file.body.includes("00-1234-5678"), false);
  const lines = file.body.split("\r\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 3);
  for (const field of file.body.split(/[\r\n,]/)) {
    assert.equal(field.startsWith("="), false);
    assert.equal(field.startsWith("+"), false);
    assert.equal(field.startsWith("@"), false);
  }
  const verification = verifyBankBatch("bca-klikbisnis", file.body);
  assert.equal(verification.ok, true);
  assert.equal(verification.detailTotalIdr, twoEmployeeTotal);
});

test("a bad debit account or date throws before a file is written", () => {
  const input = twoEmployeeBatch();
  assert.throws(
    () => formatBankBatch("bca-klikbisnis", { ...input, debitAccountNumber: "ABC" }),
    BankBatchInputError,
  );
  assert.throws(
    () => formatBankBatch("mandiri-kopra", { ...input, effectiveDate: "2026-02-31" }),
    BankBatchInputError,
  );
  const sample = input.payments[0];
  assert.ok(sample);
  assert.throws(
    () =>
      formatBankBatch("bri-qlola", {
        ...input,
        payments: [{ ...sample, amountIdr: 1 as never }],
      }),
    TypeError,
  );
});
