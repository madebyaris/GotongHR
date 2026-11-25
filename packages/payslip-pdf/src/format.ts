const MONTHS_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** `12345678n` becomes `Rp12.345.678`. */
export function formatIdr(amount: bigint): string {
  if (typeof amount !== "bigint") {
    throw new TypeError("IDR amounts must be bigint rupiah.");
  }
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}Rp${grouped}`;
}

/** Shows the last four digits of a 16-digit NIK. */
export function maskNik(nik: string): string {
  if (typeof nik !== "string") {
    throw new TypeError("Employee NIK must be 16 digits.");
  }
  const digits = nik.replaceAll(/\s/g, "");
  if (!/^\d{16}$/.test(digits)) {
    throw new TypeError("Employee NIK must be 16 digits.");
  }
  return `**** **** **** ${digits.slice(12)}`;
}

export function formatPayslipPeriod(year: number, month: number): string {
  const id = MONTHS_ID[month - 1];
  const en = MONTHS_EN[month - 1];
  if (id === undefined || en === undefined) {
    throw new TypeError("Period month must be from 1 to 12.");
  }
  if (id === en) {
    return `${id} ${year}`;
  }
  return `${id} / ${en} ${year}`;
}

export function bilingual(labelId: string, labelEn: string): string {
  if (labelId === labelEn) {
    return labelId;
  }
  return `${labelId} / ${labelEn}`;
}
