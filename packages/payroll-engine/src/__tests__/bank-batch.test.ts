import assert from "node:assert/strict";
import test from "node:test";
import { rupiah } from "../money.ts";
import { BankBatchInputError, bankBatchIds, formatBankBatch, verifyBankBatch } from "../index.ts";
import { verifyBankBatch as verifyFromSubpath } from "../bank-batch/index.ts";
import {
  firstAmount,
  increaseDetailAmount,
  increaseHeaderTotal,
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

test("BCA, BNI, BRI, and Mandiri each use their own upload layout", () => {
  const bcaLines = formatBankBatch("bca-klikbisnis", twoEmployeeBatch()).body.split("\r\n");
  assert.equal(bcaLines[0], "BCA_KLIKBISNIS,3333333333,20260115,2,3500000");
  assert.equal(bcaLines[1], "Account,Name,Amount,Bank Code,Transfer Type,Remark,Email");
  assert.equal(bcaLines[2], "1111111111,Siti Aminah,1000000,014,BCA,GAJI JAN,siti@example.com");
  assert.equal(bcaLines[3], "2222222222,Budi Santoso,2500000,014,BCA,GAJI JAN,");

  const bni = formatBankBatch("bni-direct", twoEmployeeBatch()).body.split("\r\n");
  assert.equal(bni[0], "BNI_DIRECT,3333333333,20260115,2,3500000");
  assert.equal(
    bni[1],
    "No,Debit Account,Beneficiary Account,Beneficiary Name,Currency,Amount,Remark,Transfer Type,Bank Code,Email",
  );
  assert.equal(bni[2], "1,3333333333,1111111111,Siti Aminah,IDR,1000000,GAJI JAN,INHOUSE,009,siti@example.com");
  assert.equal(bni[3], "2,3333333333,2222222222,Budi Santoso,IDR,2500000,GAJI JAN,INHOUSE,009,");

  const bri = formatBankBatch("bri-qlola", twoEmployeeBatch()).body.split("\r\n");
  assert.equal(bri[0], "NO,NAMA,ACCOUNT,AMOUNT,EMAIL,REMARK,BANK_CODE");
  assert.equal(bri[1], "1,Siti Aminah,1111111111,1000000,siti@example.com,GAJI JAN,002");
  assert.equal(bri[2], "2,Budi Santoso,2222222222,2500000,,GAJI JAN,002");
  assert.equal(bri[3], "BRI_QLOLA,3333333333,20260115,2,3500000");

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
  const second = mandiriLines[2]?.split(",") ?? [];
  assert.equal(second.length, 41);
  assert.equal(second[0], "2222222222");
  assert.equal(second[1], "Budi Santoso");
  assert.equal(second[5], "IDR");
  assert.equal(second[6], "2500000.00");
  assert.equal(second[9], "IBU");
  assert.equal(second[16], "N");
  assert.equal(second[17], "");
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
        accountName: "-Budi Santoso",
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
  assert.ok(file.body.includes("'-Budi Santoso"));
  assert.ok(file.body.includes("1234567890"));
  assert.ok(file.body.includes("0012345678"));
  assert.equal(file.body.includes("00-1234-5678"), false);
  const lines = file.body.split("\r\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 4);
  for (const field of file.body.split(/[\r\n,]/)) {
    assert.equal(field.startsWith("="), false);
    assert.equal(field.startsWith("+"), false);
    assert.equal(field.startsWith("-"), false);
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

test("an interbank code selects LLG or SKN, and a null code is excluded", () => {
  const input = twoEmployeeBatch();
  const first = input.payments[0];
  assert.ok(first);
  const bca = formatBankBatch("bca-klikbisnis", {
    ...input,
    payments: [{ ...first, bankCode: "008" }],
  });
  assert.ok(bca.body.includes(",008,LLG,"));
  const bni = formatBankBatch("bni-direct", {
    ...input,
    payments: [{ ...first, bankCode: "014" }],
  });
  assert.ok(bni.body.includes(",SKN,014,"));
  const excluded = formatBankBatch("bri-qlola", {
    ...input,
    payments: [{ ...first, bankCode: null as never }],
  });
  assert.equal(excluded.detailCount, 0);
  assert.equal(excluded.excluded[0]?.field, "bankCode");
  assert.equal(verifyBankBatch("bri-qlola", excluded.body).ok, true);
});

test("a name is cut on a character boundary", () => {
  const input = twoEmployeeBatch();
  const first = input.payments[0];
  assert.ok(first);
  const emoji = "\u{1F600}";
  const file = formatBankBatch("bca-klikbisnis", {
    ...input,
    payments: [{ ...first, accountName: `${"A".repeat(39)}${emoji}B` }],
  });
  assert.equal(file.detailCount, 1);
  assert.ok(file.body.includes(`${"A".repeat(39)}${emoji}`));
  assert.equal(file.body.includes(`${"A".repeat(39)}${emoji}B`), false);
  assert.equal(file.body.includes("\uD83D,"), false);
});

test("the verifier rejects a bad BCA debit account and a mismatched transfer type", () => {
  const bca = formatBankBatch("bca-klikbisnis", twoEmployeeBatch()).body;
  const badDebit = verifyBankBatch("bca-klikbisnis", bca.replace("BCA_KLIKBISNIS,3333333333,", "BCA_KLIKBISNIS,12,"));
  assert.equal(badDebit.ok, false);
  if (!badDebit.ok) assert.equal(badDebit.reason, "The header debit account is not 8 to 18 digits.");
  assert.equal(verifyBankBatch("bca-klikbisnis", bca.replace(",014,BCA,", ",999,BCA,")).ok, false);
  assert.equal(verifyBankBatch("bca-klikbisnis", bca.replace(",014,BCA,", ",014,LLG,")).ok, false);
  assert.equal(verifyBankBatch("bca-klikbisnis", bca.replace(",014,BCA,", ",999,RTGS,")).ok, true);
  assert.equal(verifyBankBatch("bca-klikbisnis", bca.replace(",014,BCA,", ",008,BIFAST,")).ok, true);

  const bni = formatBankBatch("bni-direct", twoEmployeeBatch()).body;
  assert.equal(verifyBankBatch("bni-direct", bni.replace(",INHOUSE,009,", ",INHOUSE,008,")).ok, false);
  assert.equal(verifyBankBatch("bni-direct", bni.replace(",INHOUSE,009,", ",SKN,009,")).ok, false);
  assert.equal(verifyBankBatch("bni-direct", bni.replace(",INHOUSE,009,", ",RTGS,014,")).ok, true);
  assert.equal(verifyBankBatch("bni-direct", bni.replace(",INHOUSE,009,", ",LLG,009,")).ok, true);
});

test("an unknown bank id fails verification and does not throw", () => {
  const result = verifyBankBatch("cimb-niaga" as never, "NO,NAMA\r\n");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "The bank id is not a known batch format.");
  assert.throws(() => formatBankBatch("cimb-niaga" as never, twoEmployeeBatch()), BankBatchInputError);
});
