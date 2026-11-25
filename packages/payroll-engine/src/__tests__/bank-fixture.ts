import { rupiah } from "../money.ts";
import type { BankBatchInput } from "../bank-batch/index.ts";

export const effectiveDate = "2026-01-15";
export const firstAmount = 1_000_000n;
export const secondAmount = 2_500_000n;
export const twoEmployeeTotal = firstAmount + secondAmount;

export function twoEmployeeBatch(): BankBatchInput {
  return {
    debitAccountNumber: "3333333333",
    effectiveDate,
    payments: [
      {
        employeeId: "siti",
        accountNumber: "1111111111",
        accountName: "Siti Aminah",
        amountIdr: rupiah(firstAmount),
        remark: "GAJI JAN",
        email: "siti@example.com",
      },
      {
        employeeId: "budi",
        accountNumber: "2222222222",
        accountName: "Budi Santoso",
        amountIdr: rupiah(secondAmount),
        remark: "GAJI JAN",
      },
    ],
  };
}

/** Adds Rp1 to the first detail amount. The header total is left as written. */
export function increaseDetailAmount(body: string, amount: bigint): string {
  const from = amount.toString();
  const to = (amount + 1n).toString();
  const dotted = `,${from}.00,`;
  const dottedIndex = body.indexOf(dotted);
  if (dottedIndex >= 0) {
    return `${body.slice(0, dottedIndex)},${to}.00,${body.slice(dottedIndex + dotted.length)}`;
  }
  const plain = `,${from},`;
  const plainIndex = body.indexOf(plain);
  if (plainIndex < 0) throw new Error(`Detail amount ${from} was not found.`);
  return `${body.slice(0, plainIndex)},${to},${body.slice(plainIndex + plain.length)}`;
}

/** Adds Rp1 to the header total and leaves the detail rows as written. */
export function increaseHeaderTotal(body: string): string {
  const newlineAt = body.indexOf("\r\n");
  const header = newlineAt >= 0 ? body.slice(0, newlineAt) : body;
  const comma = header.lastIndexOf(",");
  const raw = header.slice(comma + 1);
  const whole = raw.endsWith(".00") ? raw.slice(0, -3) : raw;
  const next = `${(BigInt(whole) + 1n).toString()}${raw.endsWith(".00") ? ".00" : ""}`;
  return `${header.slice(0, comma + 1)}${next}${body.slice(header.length)}`;
}
