import type { BankBatchId } from "./types.ts";

/**
 * Control banks use a header the verifier can sum without a second channel.
 * H,CODE,YYYYMMDD,debit,count,total
 * D,account,name,amount,remark,email-or-bank-code
 *
 * BCA detail columns follow the KlikBCA Bisnis payroll fields (account, name, amount, remark, email).
 * BNI uses BENEFICIARY fields plus a 3-digit bank code. BRI Qlola uses account, name, amount, remark, email.
 * Mandiri follows the MCM payroll upload: row 1 is P, date, debit, count, total.
 * Detail columns run through AO, with the amount in column G and IBU in column J.
 */
export const CONTROL_LAYOUT = {
  "bca-klikbisnis": { code: "BCA_KLIKBISNIS", trailing: "email", nameMax: 40, remarkMax: 18 },
  "bni-direct": { code: "BNI_DIRECT", trailing: "bank-code", nameMax: 40, remarkMax: 40 },
  "bri-qlola": { code: "BRI_QLOLA", trailing: "email", nameMax: 40, remarkMax: 40 },
} as const;

export type ControlBankId = keyof typeof CONTROL_LAYOUT;

export const MANDIRI_DETAIL_COLUMNS = 41;
export const MANDIRI_AMOUNT_INDEX = 6;

export function isControlBank(bank: BankBatchId): bank is ControlBankId {
  return bank !== "mandiri-kopra";
}
