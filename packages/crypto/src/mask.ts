/** First 4 and last 4 digits, with the middle 8 hidden. */
export function maskNik(nik: string): string {
  if (!/^\d{16}$/u.test(nik)) {
    throw new Error("NIK must be 16 digits.");
  }
  return `${nik.slice(0, 4)}********${nik.slice(12)}`;
}

/** 16-digit NPWP uses the NIK shape. 15-digit NPWP keeps the first 2 and last 4. */
export function maskNpwp(npwp: string): string {
  const digits = npwp.replace(/\D/gu, "");
  if (digits.length === 16) {
    return `${digits.slice(0, 4)}********${digits.slice(12)}`;
  }
  if (digits.length === 15) {
    return `${digits.slice(0, 2)}*********${digits.slice(11)}`;
  }
  throw new Error("NPWP must be 15 or 16 digits.");
}

/** Every digit except the last 4 becomes `*`. */
export function maskBankAccount(account: string): string {
  const digits = account.replace(/\D/gu, "");
  if (digits.length < 8 || digits.length > 20) {
    throw new Error("Bank account must be 8 to 20 digits.");
  }
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
