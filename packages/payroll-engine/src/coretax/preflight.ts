import { ptkpStatuses, type PtkpStatus } from "@gotonghr/contracts";
import { isIsoDate } from "../civil-date.ts";
import { formatScaledPercent, hasIllegalXmlChar, isAsciiDigits } from "./text.ts";
import type {
  Bpa1Amounts,
  CoretaxFieldIssue,
  CoretaxPreflightIssue,
  CoretaxPreflightReport,
  CoretaxRecord,
  CoretaxSlipType,
  CoretaxWithholder,
  ScaledRate,
} from "./types.ts";

/**
 * Lists records that must not become a Coretax slip.
 * A bad NIK, NITKU, or PTKP status is an issue. It does not throw.
 * A money or rate value that is not a bigint throws TypeError, because a number would not be integer rupiah.
 * buildCoretaxBatch omits every record with an issue. buildCoretaxSlip throws instead.
 */
export function preflightCoretaxRecords(
  records: readonly CoretaxRecord[],
  withholder: CoretaxWithholder,
  expectedSlipType?: CoretaxSlipType,
): CoretaxPreflightReport {
  const withholderIssues = checkWithholder(withholder);
  const issues: CoretaxPreflightIssue[] = [];
  const acceptedEmployeeIds: string[] = [];
  const rejectedEmployeeIds: string[] = [];
  records.forEach((record, index) => {
    const before = issues.length;
    checkRecord(record, index, withholder, expectedSlipType, issues);
    const employeeId = employeeIdOf(record);
    if (issues.length > before) rejectedEmployeeIds.push(employeeId);
    else acceptedEmployeeIds.push(employeeId);
  });
  return { issues, withholderIssues, acceptedEmployeeIds, rejectedEmployeeIds };
}

export function failedIndexes(report: CoretaxPreflightReport): Set<number> {
  return new Set(report.issues.map((issue) => issue.index));
}

function checkWithholder(withholder: CoretaxWithholder): CoretaxFieldIssue[] {
  if (typeof withholder !== "object" || withholder === null) {
    return [{ field: "npwp", reason: "Withholder NPWP must be exactly 16 ASCII digits." }];
  }
  const issues: CoretaxFieldIssue[] = [];
  const npwp = typeof withholder.npwp === "string" ? withholder.npwp : "";
  const nitku = typeof withholder.nitku === "string" ? withholder.nitku : "";
  if (!isAsciiDigits(npwp, 16)) {
    issues.push({ field: "npwp", reason: "Withholder NPWP must be exactly 16 ASCII digits." });
  }
  if (!isAsciiDigits(nitku, 22)) {
    issues.push({ field: "nitku", reason: "Withholder NITKU must be exactly 22 ASCII digits." });
  } else if (isAsciiDigits(npwp, 16) && !nitku.startsWith(npwp)) {
    issues.push({ field: "nitku", reason: "Withholder NITKU must start with the withholder NPWP." });
  }
  return issues;
}

function checkRecord(
  record: CoretaxRecord,
  index: number,
  withholder: CoretaxWithholder,
  expectedSlipType: CoretaxSlipType | undefined,
  issues: CoretaxPreflightIssue[],
): void {
  if (typeof record !== "object" || record === null) {
    push(issues, index, "", "employeeId", "Employee record is required.");
    return;
  }
  const employeeId = employeeIdOf(record);
  if (!isSafeToken(record.employeeId, 64)) {
    push(issues, index, employeeId, "employeeId", "Employee id is required.");
  }
  if (expectedSlipType !== undefined && record.slipType !== expectedSlipType) {
    push(issues, index, employeeId, "slipType", `Slip type must be ${expectedSlipType}.`);
  }
  if (typeof record.nik !== "string" || !isAsciiDigits(record.nik, 16)) {
    push(issues, index, employeeId, "nik", "NIK must be exactly 16 ASCII digits.");
  }
  if (typeof record.nitku !== "string" || !isAsciiDigits(record.nitku, 22)) {
    push(issues, index, employeeId, "nitku", "NITKU must be exactly 22 ASCII digits.");
  } else if (
    typeof withholder === "object" &&
    withholder !== null &&
    typeof withholder.npwp === "string" &&
    isAsciiDigits(withholder.npwp, 16) &&
    !record.nitku.startsWith(withholder.npwp)
  ) {
    push(issues, index, employeeId, "nitku", "NITKU must start with the withholder NPWP.");
  }
  if (typeof record.ptkpStatus !== "string" || record.ptkpStatus.length === 0) {
    push(issues, index, employeeId, "ptkpStatus", "PTKP status is required.");
  } else if (!isPtkpStatus(record.ptkpStatus)) {
    push(
      issues,
      index,
      employeeId,
      "ptkpStatus",
      "PTKP status must be TK/0, TK/1, TK/2, TK/3, K/0, K/1, K/2, or K/3.",
    );
  }
  checkText(issues, index, employeeId, "name", record.name, "Employee name", 200);
  checkYear(issues, index, employeeId, record.taxPeriodYear);
  checkTaxObject(issues, index, employeeId, record.taxObjectCode);
  checkDate(issues, index, employeeId, "withholdingDate", record.withholdingDate, "Withholding date");

  switch (record.slipType) {
    case "BPMP":
      checkMonth(issues, index, employeeId, "taxPeriodMonth", record.taxPeriodMonth, "Tax period month");
      checkCounterpart(issues, index, employeeId, record.counterpartOpt, record.passportNumber);
      checkText(issues, index, employeeId, "position", record.position, "Position", 100);
      checkText(issues, index, employeeId, "taxCertificate", record.taxCertificate, "Tax certificate", 20);
      checkMoney(issues, index, employeeId, "grossIdr", record.grossIdr, "Gross income", "positive");
      checkRate(issues, index, employeeId, "rate", record.rate, "Rate");
      return;
    case "BP21":
      checkMonth(issues, index, employeeId, "taxPeriodMonth", record.taxPeriodMonth, "Tax period month");
      checkRecipientNitku(issues, index, employeeId, record.nik, record.recipientNitku);
      checkText(issues, index, employeeId, "taxCertificate", record.taxCertificate, "Tax certificate", 20);
      checkMoney(issues, index, employeeId, "grossIdr", record.grossIdr, "Gross income", "positive");
      checkRate(issues, index, employeeId, "deemed", record.deemed, "Deemed rate");
      checkRate(issues, index, employeeId, "rate", record.rate, "Rate");
      checkDocument(issues, index, employeeId, record.document, record.documentNumber, record.documentDate);
      return;
    case "BP26":
      checkMonth(issues, index, employeeId, "taxPeriodMonth", record.taxPeriodMonth, "Tax period month");
      if (typeof record.countryCode !== "string" || !/^[A-Z]{3}$/.test(record.countryCode)) {
        push(issues, index, employeeId, "countryCode", "Country code must be three ASCII letters.");
      }
      checkText(issues, index, employeeId, "address", record.address, "Address", 200);
      checkText(issues, index, employeeId, "birthPlace", record.birthPlace, "Birth place", 100);
      checkDate(issues, index, employeeId, "birthDate", record.birthDate, "Birth date");
      checkPassport(issues, index, employeeId, record.passportNumber, true);
      checkText(issues, index, employeeId, "taxCertificate", record.taxCertificate, "Tax certificate", 20);
      checkMoney(issues, index, employeeId, "grossIdr", record.grossIdr, "Gross income", "positive");
      checkRate(issues, index, employeeId, "deemed", record.deemed, "Deemed rate");
      checkRate(issues, index, employeeId, "rate", record.rate, "Rate");
      checkDocument(issues, index, employeeId, record.document, record.documentNumber, record.documentDate);
      return;
    case "BPA1":
      checkMonth(issues, index, employeeId, "taxPeriodMonthStart", record.taxPeriodMonthStart, "Start month");
      checkMonth(issues, index, employeeId, "taxPeriodMonthEnd", record.taxPeriodMonthEnd, "End month");
      if (
        Number.isInteger(record.taxPeriodMonthStart) &&
        Number.isInteger(record.taxPeriodMonthEnd) &&
        record.taxPeriodMonthStart > record.taxPeriodMonthEnd
      ) {
        push(issues, index, employeeId, "taxPeriodMonthEnd", "End month cannot be before the start month.");
      }
      checkCounterpart(issues, index, employeeId, record.counterpartOpt, record.passportNumber);
      checkText(issues, index, employeeId, "position", record.position, "Position", 100);
      if (
        record.slipStatus !== "FullYear" &&
        record.slipStatus !== "PartialYear" &&
        record.slipStatus !== "Annualized"
      ) {
        push(issues, index, employeeId, "slipStatus", "Slip status must be FullYear, PartialYear, or Annualized.");
      }
      if (record.nextEmployer !== "Yes" && record.nextEmployer !== "No") {
        push(issues, index, employeeId, "nextEmployer", "Next employer must be Yes or No.");
      }
      checkBpa1Amounts(issues, index, employeeId, record.amounts);
      return;
    default: {
      const unexpected: never = record;
      push(issues, index, employeeId, "slipType", "Slip type must be BPMP, BP21, BP26, or BPA1.");
      return unexpected;
    }
  }
}

function checkBpa1Amounts(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  amounts: Bpa1Amounts,
): void {
  if (typeof amounts !== "object" || amounts === null) {
    push(issues, index, employeeId, "amounts", "BPA1 amounts are required.");
    return;
  }
  checkMoney(issues, index, employeeId, "grossIdr", amounts.grossIdr, "Gross income", "positive");
  checkMoney(issues, index, employeeId, "positionCostIdr", amounts.positionCostIdr, "Position cost", "non-negative");
  checkMoney(
    issues,
    index,
    employeeId,
    "pensionContributionIdr",
    amounts.pensionContributionIdr,
    "Pension contribution",
    "non-negative",
  );
  checkMoney(issues, index, employeeId, "zakatIdr", amounts.zakatIdr, "Zakat", "non-negative");
  checkMoney(issues, index, employeeId, "netIncomeIdr", amounts.netIncomeIdr, "Net income", "non-negative");
  checkMoney(
    issues,
    index,
    employeeId,
    "previousNetIncomeIdr",
    amounts.previousNetIncomeIdr,
    "Previous net income",
    "non-negative",
  );
  checkMoney(issues, index, employeeId, "ptkpIdr", amounts.ptkpIdr, "PTKP amount", "non-negative");
  checkMoney(issues, index, employeeId, "taxableIncomeIdr", amounts.taxableIncomeIdr, "PKP", "non-negative");
  if (typeof amounts.taxableIncomeIdr === "bigint" && amounts.taxableIncomeIdr >= 0n && amounts.taxableIncomeIdr % 1000n !== 0n) {
    push(issues, index, employeeId, "taxableIncomeIdr", "PKP must be a multiple of Rp1,000.");
  }
  checkMoney(issues, index, employeeId, "article17TaxIdr", amounts.article17TaxIdr, "Pasal 17 tax", "non-negative");
  checkMoney(
    issues,
    index,
    employeeId,
    "previousWithholdingIdr",
    amounts.previousWithholdingIdr,
    "Previous withholding",
    "non-negative",
  );
  checkMoney(issues, index, employeeId, "incomeTaxIdr", amounts.incomeTaxIdr, "Income tax", "non-negative");
  checkMoney(issues, index, employeeId, "incomeTaxPayableIdr", amounts.incomeTaxPayableIdr, "Tax payable", "any");
}

function checkCounterpart(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  counterpartOpt: unknown,
  passportNumber: string,
): void {
  if (counterpartOpt !== "Resident" && counterpartOpt !== "Foreign") {
    push(issues, index, employeeId, "counterpartOpt", "Counterpart must be Resident or Foreign.");
    return;
  }
  checkPassport(issues, index, employeeId, passportNumber, counterpartOpt === "Foreign");
}

function checkPassport(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  passportNumber: string,
  required: boolean,
): void {
  if (typeof passportNumber !== "string" || passportNumber.length === 0) {
    if (required) {
      push(issues, index, employeeId, "passportNumber", "Passport number is required for a foreign counterpart.");
    }
    return;
  }
  if (!/^[A-Za-z0-9]{5,20}$/.test(passportNumber)) {
    push(issues, index, employeeId, "passportNumber", "Passport number must be 5 to 20 letters or digits.");
  }
}

function checkRecipientNitku(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  nik: string,
  recipientNitku: string,
): void {
  if (typeof recipientNitku !== "string" || !isAsciiDigits(recipientNitku, 22)) {
    push(issues, index, employeeId, "recipientNitku", "Recipient NITKU must be exactly 22 ASCII digits.");
    return;
  }
  if (typeof nik === "string" && isAsciiDigits(nik, 16) && !recipientNitku.startsWith(nik)) {
    push(issues, index, employeeId, "recipientNitku", "Recipient NITKU must start with the employee NIK.");
  }
}

function checkDocument(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  document: string,
  documentNumber: string,
  documentDate: string,
): void {
  if (typeof document !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(document)) {
    push(issues, index, employeeId, "document", "Document must be a short token such as CommercialInvoice.");
  }
  checkText(issues, index, employeeId, "documentNumber", documentNumber, "Document number", 100);
  checkDate(issues, index, employeeId, "documentDate", documentDate, "Document date");
}

function checkYear(issues: CoretaxPreflightIssue[], index: number, employeeId: string, year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 2199) {
    push(issues, index, employeeId, "taxPeriodYear", "Tax year must be a calendar year from 1900 to 2199.");
  }
}

function checkMonth(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  field: string,
  month: number,
  label: string,
): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    push(issues, index, employeeId, field, `${label} must be an integer from 1 to 12.`);
  }
}

function checkTaxObject(issues: CoretaxPreflightIssue[], index: number, employeeId: string, code: string): void {
  if (typeof code !== "string" || !/^[0-9]{2}-[0-9]{3}-[0-9]{2}$/.test(code)) {
    push(issues, index, employeeId, "taxObjectCode", "Tax object code must look like 21-100-01.");
  }
}

function checkDate(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  field: string,
  value: string,
  label: string,
): void {
  if (typeof value !== "string" || !isIsoDate(value)) {
    push(issues, index, employeeId, field, `${label} must be a real date in YYYY-MM-DD.`);
  }
}

function checkText(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  field: string,
  value: string,
  label: string,
  max: number,
): void {
  if (typeof value !== "string" || value.length === 0) {
    push(issues, index, employeeId, field, `${label} is required.`);
    return;
  }
  if (value.length > max) {
    push(issues, index, employeeId, field, `${label} is longer than ${String(max)} characters.`);
    return;
  }
  if (hasIllegalXmlChar(value)) {
    push(issues, index, employeeId, field, `${label} contains a character XML cannot store.`);
  }
}

function checkMoney(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  field: string,
  value: bigint,
  label: string,
  mode: "positive" | "non-negative" | "any",
): void {
  if (typeof value !== "bigint") {
    throw new TypeError(`${field} must be integer rupiah as bigint.`);
  }
  if (mode === "any") return;
  if (value < 0n) {
    push(issues, index, employeeId, field, `${label} cannot be negative.`);
    return;
  }
  if (mode === "positive" && value === 0n) {
    push(issues, index, employeeId, field, `${label} must be greater than zero.`);
  }
}

function checkRate(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  field: string,
  rate: ScaledRate,
  label: string,
): void {
  if (typeof rate !== "object" || rate === null) {
    throw new TypeError(`${field} must be an integer rate.`);
  }
  if (typeof rate.ratePerScale !== "bigint" || typeof rate.rateScale !== "bigint") {
    throw new TypeError(`${field} must use integer bigint ratePerScale and rateScale.`);
  }
  if (formatScaledPercent(rate.ratePerScale, rate.rateScale) === null) {
    push(
      issues,
      index,
      employeeId,
      field,
      `${label} must be a percent from 0 to 100 with at most four decimal places.`,
    );
  }
}

function push(
  issues: CoretaxPreflightIssue[],
  index: number,
  employeeId: string,
  field: string,
  reason: string,
): void {
  issues.push({ index, employeeId, field, reason });
}

function employeeIdOf(record: CoretaxRecord): string {
  if (typeof record !== "object" || record === null || typeof record.employeeId !== "string") return "";
  return record.employeeId;
}

function isSafeToken(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max && !hasIllegalXmlChar(value);
}

function isPtkpStatus(value: string): value is PtkpStatus {
  return ptkpStatuses.some((status) => status === value);
}
