import { isIsoDate } from "../civil-date.ts";
import { rupiah } from "../money.ts";
import { BankBatchInputError } from "./errors.ts";
import {
  BANK_FORMATS,
  BCA_COLUMNS,
  BNI_COLUMNS,
  BRI_COLUMNS,
  isKnownBank,
  MANDIRI_DETAIL_COLUMNS,
} from "./layout.ts";
import { sanitizeAccountNumber, sanitizeBankCode, sanitizeBankText, sanitizeEmail } from "./sanitize.ts";
import type { BankBatchExclusion, BankBatchFile, BankBatchId, BankBatchInput, BankPayment } from "./types.ts";
import { verifyBankBatch } from "./verify.ts";

interface PreparedRow {
  readonly accountNumber: string;
  readonly accountName: string;
  readonly amountIdr: bigint;
  readonly remark: string;
  readonly email: string;
  readonly bankCode: string;
  readonly addressLine1: string;
}

/**
 * Writes one bank's upload file. The control total is the sum of the rows actually emitted.
 * A row with a bad account, an empty name, a bad bank code, or a non-positive amount is excluded.
 * An amount that is not a bigint throws TypeError.
 */
export function formatBankBatch(bank: BankBatchId, input: BankBatchInput): BankBatchFile {
  if (!isKnownBank(bank)) {
    throw new BankBatchInputError("Bank id must be bca-klikbisnis, mandiri-kopra, bni-direct, or bri-qlola.");
  }
  switch (bank) {
    case "bca-klikbisnis":
      return formatBca(input);
    case "mandiri-kopra":
      return formatMandiri(input);
    case "bni-direct":
      return formatBni(input);
    case "bri-qlola":
      return formatBri(input);
    default: {
      const unexpected: never = bank;
      throw new BankBatchInputError(`Bank id is not a known batch format: ${String(unexpected)}`);
    }
  }
}

export function formatBcaKlikbisnis(input: BankBatchInput): BankBatchFile {
  return formatBankBatch("bca-klikbisnis", input);
}

export function formatMandiriKopra(input: BankBatchInput): BankBatchFile {
  return formatBankBatch("mandiri-kopra", input);
}

export function formatBniDirect(input: BankBatchInput): BankBatchFile {
  return formatBankBatch("bni-direct", input);
}

export function formatBriQlola(input: BankBatchInput): BankBatchFile {
  return formatBankBatch("bri-qlola", input);
}

function formatBca(input: BankBatchInput): BankBatchFile {
  const header = readHeader(input);
  const limits = BANK_FORMATS["bca-klikbisnis"];
  const prepared = prepareRows(input.payments, {
    nameMax: limits.nameMax,
    remarkMax: limits.remarkMax,
    bankCode: "014",
  });
  const total = sumAmounts(prepared.rows);
  const lines = [
    ["BCA_KLIKBISNIS", header.debit, header.yyyymmdd, String(prepared.rows.length), total.toString()].join(","),
    BCA_COLUMNS,
    ...prepared.rows.map((row) =>
      [
        row.accountNumber,
        row.accountName,
        row.amountIdr.toString(),
        row.bankCode,
        row.bankCode === "014" ? "BCA" : "LLG",
        row.remark,
        row.email,
      ].join(","),
    ),
  ];
  return finish("bca-klikbisnis", header.yyyymmdd, lines, total, prepared.rows.length, prepared.excluded);
}

function formatBni(input: BankBatchInput): BankBatchFile {
  const header = readHeader(input);
  const limits = BANK_FORMATS["bni-direct"];
  const prepared = prepareRows(input.payments, {
    nameMax: limits.nameMax,
    remarkMax: limits.remarkMax,
    bankCode: "009",
  });
  const total = sumAmounts(prepared.rows);
  const lines = [
    ["BNI_DIRECT", header.debit, header.yyyymmdd, String(prepared.rows.length), total.toString()].join(","),
    BNI_COLUMNS,
    ...prepared.rows.map((row, index) =>
      [
        String(index + 1),
        header.debit,
        row.accountNumber,
        row.accountName,
        "IDR",
        row.amountIdr.toString(),
        row.remark,
        row.bankCode === "009" ? "INHOUSE" : "SKN",
        row.bankCode,
        row.email,
      ].join(","),
    ),
  ];
  return finish("bni-direct", header.yyyymmdd, lines, total, prepared.rows.length, prepared.excluded);
}

function formatBri(input: BankBatchInput): BankBatchFile {
  const header = readHeader(input);
  const limits = BANK_FORMATS["bri-qlola"];
  const prepared = prepareRows(input.payments, {
    nameMax: limits.nameMax,
    remarkMax: limits.remarkMax,
    bankCode: "002",
  });
  const total = sumAmounts(prepared.rows);
  const lines = [
    BRI_COLUMNS,
    ...prepared.rows.map((row, index) =>
      [
        String(index + 1),
        row.accountName,
        row.accountNumber,
        row.amountIdr.toString(),
        row.email,
        row.remark,
        row.bankCode,
      ].join(","),
    ),
    ["BRI_QLOLA", header.debit, header.yyyymmdd, String(prepared.rows.length), total.toString()].join(","),
  ];
  return finish("bri-qlola", header.yyyymmdd, lines, total, prepared.rows.length, prepared.excluded);
}

function formatMandiri(input: BankBatchInput): BankBatchFile {
  const header = readHeader(input);
  const limits = BANK_FORMATS["mandiri-kopra"];
  const prepared = prepareRows(input.payments, {
    nameMax: limits.nameMax,
    remarkMax: limits.remarkMax,
    bankCode: "ignore",
  });
  const total = sumAmounts(prepared.rows);
  const lines = [
    ["P", header.yyyymmdd, header.debit, String(prepared.rows.length), `${total.toString()}.00`].join(","),
    ...prepared.rows.map((row) => mandiriDetail(row)),
  ];
  return finish("mandiri-kopra", header.yyyymmdd, lines, total, prepared.rows.length, prepared.excluded);
}

function mandiriDetail(row: PreparedRow): string {
  const fields = Array.from({ length: MANDIRI_DETAIL_COLUMNS }, () => "");
  fields[0] = row.accountNumber;
  fields[1] = row.accountName;
  fields[2] = row.addressLine1;
  fields[5] = "IDR";
  fields[6] = `${row.amountIdr.toString()}.00`;
  fields[7] = row.remark;
  fields[8] = row.remark;
  fields[9] = "IBU";
  fields[16] = row.email.length > 0 ? "Y" : "N";
  fields[17] = row.email;
  fields[40] = row.remark;
  return fields.join(",");
}

function finish(
  bank: BankBatchId,
  yyyymmdd: string,
  lines: readonly string[],
  total: bigint,
  detailCount: number,
  excluded: readonly BankBatchExclusion[],
): BankBatchFile {
  const body = `${lines.join("\r\n")}\r\n`;
  const verification = verifyBankBatch(bank, body);
  if (!verification.ok) {
    throw new Error(`Bank batch invariant failed: ${verification.reason}`);
  }
  return {
    bank,
    fileName: `${bank}-${yyyymmdd}.csv`,
    mediaType: "text/csv",
    body,
    detailCount,
    totalIdr: rupiah(total),
    excluded,
  };
}

function readHeader(input: BankBatchInput): { debit: string; yyyymmdd: string } {
  if (typeof input !== "object" || input === null || !Array.isArray(input.payments)) {
    throw new BankBatchInputError("Payments must be a list.");
  }
  const debit = sanitizeAccountNumber(input.debitAccountNumber);
  if (debit === null) throw new BankBatchInputError("Debit account number must be 8 to 18 digits.");
  if (typeof input.effectiveDate !== "string" || !isIsoDate(input.effectiveDate)) {
    throw new BankBatchInputError("Effective date must be a real date in YYYY-MM-DD.");
  }
  return { debit, yyyymmdd: input.effectiveDate.replaceAll("-", "") };
}

function prepareRows(
  payments: readonly BankPayment[],
  options: { nameMax: number; remarkMax: number; bankCode: string | "ignore" },
): { rows: PreparedRow[]; excluded: BankBatchExclusion[] } {
  const rows: PreparedRow[] = [];
  const excluded: BankBatchExclusion[] = [];
  for (const payment of payments) {
    const employeeId = typeof payment?.employeeId === "string" ? payment.employeeId : "";
    if (typeof payment !== "object" || payment === null) {
      excluded.push({ employeeId, field: "employeeId", reason: "Payment record is required." });
      continue;
    }
    if (typeof payment.amountIdr !== "bigint") {
      throw new TypeError("amountIdr must be integer rupiah as bigint.");
    }
    if (payment.amountIdr <= 0n) {
      excluded.push({ employeeId, field: "amountIdr", reason: "Amount must be a positive integer rupiah." });
      continue;
    }
    const accountNumber = sanitizeAccountNumber(payment.accountNumber);
    if (accountNumber === null) {
      excluded.push({ employeeId, field: "accountNumber", reason: "Account number must be 8 to 18 digits." });
      continue;
    }
    const accountName = sanitizeBankText(payment.accountName, options.nameMax);
    if (accountName.length === 0) {
      excluded.push({
        employeeId,
        field: "accountName",
        reason: "Account name is empty after removing delimiters.",
      });
      continue;
    }
    const bankCode = resolveBankCode(payment.bankCode, options.bankCode);
    if (bankCode === null) {
      excluded.push({ employeeId, field: "bankCode", reason: "Bank code must be three digits." });
      continue;
    }
    const remarkText = sanitizeBankText(payment.remark, options.remarkMax);
    const remark = remarkText.length > 0 ? remarkText : "PAYROLL";
    rows.push({
      accountNumber,
      accountName,
      amountIdr: payment.amountIdr,
      remark,
      email: sanitizeEmail(payment.email),
      bankCode,
      addressLine1: sanitizeBankText(payment.addressLine1 ?? "", 40),
    });
  }
  return { rows, excluded };
}

function resolveBankCode(value: string | undefined, fallback: string | "ignore"): string | null {
  if (fallback === "ignore") return "";
  if (value === undefined) return fallback;
  const code = sanitizeBankCode(value);
  if (code === null || code.length === 0) return null;
  return code;
}

function sumAmounts(rows: readonly PreparedRow[]): bigint {
  let total = 0n;
  for (const row of rows) total += row.amountIdr;
  return total;
}
