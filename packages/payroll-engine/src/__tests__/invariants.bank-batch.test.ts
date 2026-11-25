import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { rupiah } from "../money.ts";
import { bankBatchIds, formatBankBatch, verifyBankBatch, type BankBatchId } from "../index.ts";
import { firstAmount, increaseDetailAmount, twoEmployeeBatch, twoEmployeeTotal } from "./bank-fixture.ts";

test("two employees keep the header total, and one rupiah breaks it", () => {
  for (const bank of bankBatchIds) {
    const file = formatBankBatch(bank, twoEmployeeBatch());
    const verification = verifyBankBatch(bank, file.body);
    assert.equal(verification.ok, true);
    assert.equal(verification.headerTotalIdr, verification.detailTotalIdr);
    assert.equal(verification.detailTotalIdr, twoEmployeeTotal);
    const failed = verifyBankBatch(bank, increaseDetailAmount(file.body, firstAmount));
    assert.equal(failed.ok, false);
    assert.equal(failed.detailTotalIdr - failed.headerTotalIdr, 1n);
  }
});

test("a random pair of payments still ties the header to the emitted rows", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1_000_000n, max: 4_000_000n }),
      fc.bigInt({ min: 5_000_000n, max: 9_000_000n }),
      fc.constantFrom(...bankBatchIds),
      (left, right, bank: BankBatchId) => {
        const file = formatBankBatch(bank, {
          debitAccountNumber: "3333333333",
          effectiveDate: "2026-01-15",
          payments: [
            {
              employeeId: "left",
              accountNumber: "8888888888",
              accountName: "Left",
              amountIdr: rupiah(left),
              remark: "GAJI",
            },
            {
              employeeId: "right",
              accountNumber: "7777777777",
              accountName: "Right",
              amountIdr: rupiah(right),
              remark: "GAJI",
            },
          ],
        });
        const verification = verifyBankBatch(bank, file.body);
        const failed = verifyBankBatch(bank, increaseDetailAmount(file.body, left));
        return (
          verification.ok &&
          verification.headerTotalIdr === left + right &&
          file.totalIdr === left + right &&
          !failed.ok &&
          failed.detailTotalIdr - failed.headerTotalIdr === 1n
        );
      },
    ),
    { seed: 20261125, numRuns: 20 },
  );
});
