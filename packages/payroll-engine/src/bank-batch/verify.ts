import {
  BCA_COLUMNS,
  BCA_TRANSFER_TYPES,
  BNI_COLUMNS,
  BNI_TRANSFER_TYPES,
  BRI_COLUMNS,
  isKnownBank,
  MANDIRI_AMOUNT_INDEX,
  MANDIRI_DETAIL_COLUMNS,
} from "./layout.ts";
import type { BankBatchId, BankBatchVerification } from "./types.ts";

/**
 * Reads the control total and the detail amounts from the file that was emitted.
 * A one-rupiah difference fails. The check does not trust the formatter's returned total.
 */
export function verifyBankBatch(bank: BankBatchId, body: string): BankBatchVerification {
  if (!isKnownBank(bank)) return failed("The bank id is not a known batch format.");
  switch (bank) {
    case "bca-klikbisnis":
      return verifyBca(body);
    case "mandiri-kopra":
      return verifyMandiri(body);
    case "bni-direct":
      return verifyBni(body);
    case "bri-qlola":
      return verifyBri(body);
    default: {
      const unexpected: never = bank;
      return failed(`The bank id is not a known batch format: ${String(unexpected)}`);
    }
  }
}

function verifyBca(body: string): BankBatchVerification {
  const lines = splitLines(body);
  if (lines === null || lines.length < 2) return failed("The file has no header.");
  const header = lines[0]?.split(",") ?? [];
  if (header.length !== 5 || header[0] !== "BCA_KLIKBISNIS") {
    return failed("The header is not a BCA KlikBISNIS control record.");
  }
  if (!isAccount(header[1])) return failed("The header debit account is not 8 to 18 digits.");
  if (!/^[0-9]{8}$/.test(header[2] ?? "")) return failed("The header date is not YYYYMMDD.");
  const headerCount = parseCount(header[3]);
  const headerTotal = parseWholeIdr(header[4]);
  if (headerCount === null || headerTotal === null) return failed("The header count or total is not an integer.");
  if (lines[1] !== BCA_COLUMNS) return failed("The column header is not the BCA KlikBISNIS upload header.");
  return sumDetails(lines.slice(2), headerCount, headerTotal, (fields) => {
    if (fields.length !== 7) return "A BCA detail row does not have 7 columns.";
    if (!isAccount(fields[0]) || !bcaRouteOk(fields[3], fields[4])) {
      return "A BCA detail row pairs 014 with BCA, any other code with LLG, or uses RTGS or BIFAST.";
    }
    return readAmount(fields[2]);
  });
}

function verifyBni(body: string): BankBatchVerification {
  const lines = splitLines(body);
  if (lines === null || lines.length < 2) return failed("The file has no header.");
  const header = lines[0]?.split(",") ?? [];
  if (header.length !== 5 || header[0] !== "BNI_DIRECT") {
    return failed("The header is not a BNI Direct control record.");
  }
  if (!isAccount(header[1])) return failed("The header debit account is not 8 to 18 digits.");
  if (!/^[0-9]{8}$/.test(header[2] ?? "")) return failed("The header date is not YYYYMMDD.");
  const headerCount = parseCount(header[3]);
  const headerTotal = parseWholeIdr(header[4]);
  if (headerCount === null || headerTotal === null) return failed("The header count or total is not an integer.");
  if (lines[1] !== BNI_COLUMNS) return failed("The column header is not the BNI Direct upload header.");
  const debit = header[1] ?? "";
  return sumDetails(lines.slice(2), headerCount, headerTotal, (fields, detailCount) => {
    if (fields.length !== 10) return "A BNI detail row does not have 10 columns.";
    if (fields[0] !== String(detailCount + 1) || fields[1] !== debit || fields[4] !== "IDR") {
      return "A BNI detail row has the wrong number, debit account, or currency.";
    }
    if (!isAccount(fields[2]) || !bniRouteOk(fields[8], fields[7])) {
      return "A BNI detail row pairs 009 with INHOUSE, any other code with SKN, or uses RTGS or LLG.";
    }
    return readAmount(fields[5]);
  });
}

function verifyBri(body: string): BankBatchVerification {
  const lines = splitLines(body);
  if (lines === null || lines.length < 2) return failed("The file has no header.");
  if (lines[0] !== BRI_COLUMNS) return failed("The column header is not the BRI Qlola upload header.");
  const trailer = lines[lines.length - 1]?.split(",") ?? [];
  if (trailer.length !== 5 || trailer[0] !== "BRI_QLOLA") {
    return failed("The trailer is not a BRI Qlola control record.");
  }
  if (!isAccount(trailer[1])) return failed("The trailer debit account is not 8 to 18 digits.");
  if (!/^[0-9]{8}$/.test(trailer[2] ?? "")) return failed("The trailer date is not YYYYMMDD.");
  const headerCount = parseCount(trailer[3]);
  const headerTotal = parseWholeIdr(trailer[4]);
  if (headerCount === null || headerTotal === null) return failed("The trailer count or total is not an integer.");
  return sumDetails(lines.slice(1, -1), headerCount, headerTotal, (fields, detailCount) => {
    if (fields.length !== 7) return "A BRI detail row does not have 7 columns.";
    if (fields[0] !== String(detailCount + 1) || !isAccount(fields[2]) || !isBankCode(fields[6])) {
      return "A BRI detail row has the wrong number, account, or bank code.";
    }
    return readAmount(fields[3]);
  });
}

function verifyMandiri(body: string): BankBatchVerification {
  const lines = splitLines(body);
  if (lines === null || lines.length === 0) return failed("The file has no header.");
  const header = lines[0]?.split(",") ?? [];
  if (header.length !== 5 || header[0] !== "P") return failed("The header is not a Mandiri payroll control record.");
  if (!/^[0-9]{8}$/.test(header[1] ?? "")) return failed("The header date is not YYYYMMDD.");
  const headerCount = parseCount(header[3]);
  const headerTotal = parseMandiriAmount(header[4]);
  if (headerCount === null || headerTotal === null) return failed("The header count or total is not whole rupiah.");
  return sumDetails(lines.slice(1), headerCount, headerTotal, (fields) => {
    if (fields.length !== MANDIRI_DETAIL_COLUMNS) return "A Mandiri detail row does not have 41 columns.";
    if (fields[5] !== "IDR" || fields[9] !== "IBU") return "A Mandiri detail row is missing IDR or IBU.";
    const amount = parseMandiriAmount(fields[MANDIRI_AMOUNT_INDEX]);
    if (amount === null || amount <= 0n) return "A detail amount is not positive whole rupiah.";
    return amount;
  });
}

function sumDetails(
  lines: readonly string[],
  headerCount: number,
  headerTotal: bigint,
  read: (fields: string[], detailCount: number) => bigint | string,
): BankBatchVerification {
  let detailTotal = 0n;
  let detailCount = 0;
  for (const line of lines) {
    const fields = line.split(",");
    const amount = read(fields, detailCount);
    if (typeof amount === "string") return failed(amount, headerTotal, detailTotal, detailCount);
    detailTotal += amount;
    detailCount += 1;
  }
  return compare(headerCount, headerTotal, detailCount, detailTotal);
}

function readAmount(value: string | undefined): bigint | string {
  const amount = parseWholeIdr(value);
  if (amount === null || amount <= 0n) return "A detail amount is not a positive integer rupiah.";
  return amount;
}

function compare(
  headerCount: number,
  headerTotal: bigint,
  detailCount: number,
  detailTotal: bigint,
): BankBatchVerification {
  if (headerCount !== detailCount) {
    return failed("Header count does not match the detail rows.", headerTotal, detailTotal, detailCount);
  }
  if (headerTotal !== detailTotal) {
    return failed("Header total does not match the sum of detail amounts.", headerTotal, detailTotal, detailCount);
  }
  return { ok: true, headerTotalIdr: headerTotal, detailTotalIdr: detailTotal, detailCount };
}

function splitLines(body: string): string[] | null {
  if (typeof body !== "string" || body.length === 0) return null;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const normalized = body.endsWith(newline) ? body.slice(0, -newline.length) : body;
  if (normalized.length === 0) return [];
  const lines = normalized.split(newline);
  if (lines.some((line) => line.length === 0 || line.includes("\n") || line.includes("\r"))) return null;
  return lines;
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/.test(value) || value.length > 15) return null;
  let count = 0;
  for (const char of value) count = count * 10 + (char.charCodeAt(0) - 48);
  return count;
}

function parseWholeIdr(value: string | undefined): bigint | null {
  if (value === undefined || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}

function parseMandiriAmount(value: string | undefined): bigint | null {
  if (value === undefined || !/^[0-9]+\.00$/.test(value)) return null;
  return BigInt(value.slice(0, -3));
}

function isAccount(value: string | undefined): boolean {
  return value !== undefined && /^[0-9]{8,18}$/.test(value);
}

function isBankCode(value: string | undefined): boolean {
  return value !== undefined && /^[0-9]{3}$/.test(value);
}

function isMember(value: string | undefined, allowed: readonly string[]): boolean {
  return value !== undefined && allowed.includes(value);
}

function bcaRouteOk(bankCode: string | undefined, transferType: string | undefined): boolean {
  if (!isBankCode(bankCode) || !isMember(transferType, BCA_TRANSFER_TYPES)) return false;
  if (transferType === "RTGS" || transferType === "BIFAST") return true;
  if (transferType === "BCA") return bankCode === "014";
  if (transferType === "LLG") return bankCode !== "014";
  return false;
}

function bniRouteOk(bankCode: string | undefined, transferType: string | undefined): boolean {
  if (!isBankCode(bankCode) || !isMember(transferType, BNI_TRANSFER_TYPES)) return false;
  if (transferType === "RTGS" || transferType === "LLG") return true;
  if (transferType === "INHOUSE") return bankCode === "009";
  if (transferType === "SKN") return bankCode !== "009";
  return false;
}

function failed(
  reason: string,
  headerTotalIdr = 0n,
  detailTotalIdr = 0n,
  detailCount = 0,
): BankBatchVerification {
  return { ok: false, reason, headerTotalIdr, detailTotalIdr, detailCount };
}
