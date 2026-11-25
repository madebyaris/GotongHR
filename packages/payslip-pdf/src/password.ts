const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Default payslip password: the employee date of birth as `ddMMyyyy`.
 * `1995-08-17` becomes `17081995`.
 */
export function passwordFromDateOfBirth(dateOfBirth: string): string {
  if (typeof dateOfBirth !== "string") {
    throw new TypeError("Date of birth must be YYYY-MM-DD.");
  }
  const match = ISO_DATE.exec(dateOfBirth);
  if (!match) {
    throw new TypeError("Date of birth must be YYYY-MM-DD.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new TypeError("Date of birth must be a real calendar day.");
  }
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const yyyy = String(year).padStart(4, "0");
  return `${dd}${mm}${yyyy}`;
}

/** Rejects a password that would let pdfkit emit an unencrypted file. */
export function assertPayslipPassword(password: string): void {
  if (typeof password !== "string" || password.trim() === "") {
    throw new TypeError("Payslip PDF password must contain a non-whitespace character.");
  }
}

/**
 * Tenant override is passed through unchanged when it is set.
 * A missing override uses the date of birth.
 * An empty or whitespace override is rejected and does not fall back.
 */
export function resolvePayslipPassword(input: {
  dateOfBirth: string;
  tenantOverride?: string | null;
}): string {
  if (input.tenantOverride !== undefined && input.tenantOverride !== null) {
    if (typeof input.tenantOverride !== "string") {
      throw new TypeError("Tenant payslip password override must be a string.");
    }
    assertPayslipPassword(input.tenantOverride);
    return input.tenantOverride;
  }
  return passwordFromDateOfBirth(input.dateOfBirth);
}
