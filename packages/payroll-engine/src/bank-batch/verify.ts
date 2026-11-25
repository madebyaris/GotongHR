import { CONTROL_LAYOUT, isControlBank, MANDIRI_AMOUNT_INDEX, MANDIRI_DETAIL_COLUMNS } from "./layout.ts";
import type { BankBatchId, BankBatchVerification } from "./types.ts";

/**
 * Reads the header total and the detail amounts from the file that was emitted.
 * A one-rupiah difference fails. The check does not trust the formatter's returned total.
 */
export function verifyBankBatch(bank: BankBatchId, body: string): BankBatchVerification {
  if (bank === "mandiri-kopra") return verifyMandiri(body);
  if (!isControlBank(bank)) return failed("The bank id is not a known batch format.");
  return verifyControl(bank, body);
}

function verifyControl(bank: keyof typeof CONTROL_LAYOUT, body: string): BankBatchVerification {
  const lines = splitLines(body);
  if (lines === null || lines.length === 0) return failed("The file has no header.");
  const header = lines[0]?.split(",") ?? [];
  const layout = CONTROL_LAYOUT[bank];
  if (header.length !== 6 || header[0] !== "H" || header[1] !== layout.code) {
    return failed("The header is not the expected control record.");
  }
  if (!/^[0-9]{8}$/.test(header[2] ?? "")) return failed("The header date is not YYYYMMDD.");
  const headerCount = parseCount(header[4]);
  const headerTotal = parseWholeIdr(header[5]);
  if (headerCount === null || headerTotal === null) return failed("The header count or total is not an integer.");
  let detailTotal = 0n;
  let detailCount = 0;
  for (const line of lines.slice(1)) {
    const fields = line.split(",");
    if (fields.length !== 6 || fields[0] !== "D") {
      return failed("A detail row is not a complete D record.", headerTotal, detailTotal, detailCount);
    }
    const amount = parseWholeIdr(fields[3]);
    if (amount === null || amount <= 0n) {
      return failed("A detail amount is not a positive integer rupiah.", headerTotal, detailTotal, detailCount);
    }
    detailTotal += amount;
    detailCount += 1;
  }
  return compare(headerCount, headerTotal, detailCount, detailTotal);
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
  let detailTotal = 0n;
  let detailCount = 0;
  for (const line of lines.slice(1)) {
    const fields = line.split(",");
    if (fields.length !== MANDIRI_DETAIL_COLUMNS) {
      return failed("A Mandiri detail row does not have 41 columns.", headerTotal, detailTotal, detailCount);
    }
    if (fields[5] !== "IDR" || fields[9] !== "IBU") {
      return failed("A Mandiri detail row is missing IDR or IBU.", headerTotal, detailTotal, detailCount);
    }
    const amount = parseMandiriAmount(fields[MANDIRI_AMOUNT_INDEX]);
    if (amount === null || amount <= 0n) {
      return failed("A detail amount is not positive whole rupiah.", headerTotal, detailTotal, detailCount);
    }
    detailTotal += amount;
    detailCount += 1;
  }
  return compare(headerCount, headerTotal, detailCount, detailTotal);
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

function failed(
  reason: string,
  headerTotalIdr = 0n,
  detailTotalIdr = 0n,
  detailCount = 0,
): BankBatchVerification {
  return { ok: false, reason, headerTotalIdr, detailTotalIdr, detailCount };
}
