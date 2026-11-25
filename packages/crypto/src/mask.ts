import { isPiiField, type PiiField } from "./fields.ts";

const SEPARATORS = /[\s./-]/gu;

/** Digits only, after dots, dashes, slashes, and spaces. Any other character is rejected. */
function digits(value: string, label: string): string {
  if (!/^[\d\s./-]+$/u.test(value)) {
    throw new Error(`${label} contains an invalid character.`);
  }
  return value.replace(SEPARATORS, "");
}

function hideMiddle(digitsOnly: string, head: number, tail: number): string {
  const hidden = digitsOnly.length - head - tail;
  return `${digitsOnly.slice(0, head)}${"*".repeat(hidden)}${digitsOnly.slice(-tail)}`;
}

/** First 4 and last 4 digits, with the middle 8 hidden. */
export function maskNik(nik: string): string {
  if (!/^\d{16}$/u.test(nik)) {
    throw new Error("NIK must be 16 digits.");
  }
  return hideMiddle(nik, 4, 4);
}

/** A family card number is 16 digits and uses the NIK mask. */
export function maskKkNumber(kkNumber: string): string {
  const compact = digits(kkNumber, "KK number");
  if (!/^\d{16}$/u.test(compact)) {
    throw new Error("KK number must be 16 digits.");
  }
  return hideMiddle(compact, 4, 4);
}

/** 16-digit NPWP uses the NIK shape. 15-digit NPWP keeps the first 2 and last 4. */
export function maskNpwp(npwp: string): string {
  const compact = digits(npwp, "NPWP");
  if (compact.length === 16) return hideMiddle(compact, 4, 4);
  if (compact.length === 15) return hideMiddle(compact, 2, 4);
  throw new Error("NPWP must be 15 or 16 digits.");
}

/** BPJS Kesehatan membership numbers are 13 digits. The first 4 and last 4 stay visible. */
export function maskBpjsKesehatan(value: string): string {
  const compact = digits(value, "BPJS Kesehatan number");
  if (!/^\d{13}$/u.test(compact)) {
    throw new Error("BPJS Kesehatan number must be 13 digits.");
  }
  return hideMiddle(compact, 4, 4);
}

/** BPJS Ketenagakerjaan membership numbers are 11 digits. The first 4 and last 4 stay visible. */
export function maskBpjsTk(value: string): string {
  const compact = digits(value, "BPJS TK number");
  if (!/^\d{11}$/u.test(compact)) {
    throw new Error("BPJS TK number must be 11 digits.");
  }
  return hideMiddle(compact, 4, 4);
}

/** Every digit except the last 4 becomes `*`. */
export function maskBankAccount(account: string): string {
  const compact = digits(account, "Bank account");
  if (compact.length < 8 || compact.length > 20) {
    throw new Error("Bank account must be 8 to 20 digits.");
  }
  return hideMiddle(compact, 0, 4);
}

/** Masks one stored PII field. List responses use this instead of decryption. */
export function maskPii(field: PiiField, value: string): string {
  if (!isPiiField(field)) throw new Error("unknown pii field");
  switch (field) {
    case "nik":
      return maskNik(value);
    case "npwp":
      return maskNpwp(value);
    case "kk_number":
      return maskKkNumber(value);
    case "bpjs_kesehatan_no":
      return maskBpjsKesehatan(value);
    case "bpjs_tk_no":
      return maskBpjsTk(value);
    case "bank_account_number":
      return maskBankAccount(value);
  }
}
