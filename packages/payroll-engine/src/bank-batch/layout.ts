import type { BankBatchId } from "./types.ts";

/**
 * v1 upload maps. These are the fields each bank's payroll screen collects.
 * They are not a file downloaded from the bank.
 *
 * bca-klikbisnis: KlikBCA Bisnis mass transfer.
 * Control row is BCA_KLIKBISNIS, debit account, YYYYMMDD, count, total.
 * Detail columns are Account, Name, Amount, Bank Code, Transfer Type, Remark, Email.
 * Bank code 014 is BCA. Any other code is LLG.
 * The transfer type column also allows RTGS and BIFAST, and v1 does not guess those.
 *
 * mandiri-kopra: MCM payroll CSV.
 * Control row is P, YYYYMMDD, debit account, count, total with two decimals.
 * Each detail row has 41 columns, A through AO. Amount is column G, IDR is column F, and IBU is column J.
 *
 * bni-direct: BNI Direct mass payroll.
 * Control row is BNI_DIRECT, debit account, YYYYMMDD, count, total.
 * Detail columns are No, Debit Account, Beneficiary Account, Beneficiary Name, Currency, Amount, Remark, Transfer Type, Bank Code, Email.
 * Bank code 009 is INHOUSE. Any other code is SKN.
 *
 * bri-qlola: BRI Qlola mass transfer.
 * The first row is NO, NAMA, ACCOUNT, AMOUNT, EMAIL, REMARK, BANK_CODE.
 * The trailer is BRI_QLOLA, debit account, YYYYMMDD, count, total.
 * An omitted bank code is 002.
 */
export const BANK_FORMATS = {
  "bca-klikbisnis": { nameMax: 40, remarkMax: 18 },
  "mandiri-kopra": { nameMax: 70, remarkMax: 40 },
  "bni-direct": { nameMax: 40, remarkMax: 40 },
  "bri-qlola": { nameMax: 40, remarkMax: 40 },
} as const satisfies Record<BankBatchId, { readonly nameMax: number; readonly remarkMax: number }>;

export const BCA_COLUMNS = "Account,Name,Amount,Bank Code,Transfer Type,Remark,Email";
export const BNI_COLUMNS =
  "No,Debit Account,Beneficiary Account,Beneficiary Name,Currency,Amount,Remark,Transfer Type,Bank Code,Email";
export const BRI_COLUMNS = "NO,NAMA,ACCOUNT,AMOUNT,EMAIL,REMARK,BANK_CODE";

export const BCA_TRANSFER_TYPES = ["BCA", "LLG", "RTGS", "BIFAST"] as const;
export const BNI_TRANSFER_TYPES = ["INHOUSE", "SKN", "RTGS", "LLG"] as const;

export const MANDIRI_DETAIL_COLUMNS = 41;
export const MANDIRI_AMOUNT_INDEX = 6;

export function isKnownBank(bank: string): bank is BankBatchId {
  return Object.hasOwn(BANK_FORMATS, bank);
}
