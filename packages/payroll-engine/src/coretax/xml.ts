import { escapeXml, formatScaledPercent } from "./text.ts";
import type {
  Bpa1Record,
  Bp21Record,
  Bp26Record,
  BpmpRecord,
  CoretaxRecord,
  CoretaxSlipType,
  CoretaxWithholder,
  ScaledRate,
} from "./types.ts";

/**
 * BPMP and BP21 element order follows the DJP Coretax templates dated 7 Nov 2024
 * (MmPayrollBulk and Bp21Bulk). BP26 uses Bp26Bulk and BPA1 uses A1Bulk in that same style.
 * Official XSD files in src/coretax/xsd are the acceptance check.
 * This writer does not download a schema and does not call DJP.
 */
const DOCUMENT = {
  BPMP: { root: "MmPayrollBulk", list: "ListOfMmPayroll", item: "MmPayroll" },
  BP21: { root: "Bp21Bulk", list: "ListOfBp21", item: "Bp21" },
  BP26: { root: "Bp26Bulk", list: "ListOfBp26", item: "Bp26" },
  BPA1: { root: "A1Bulk", list: "ListOfA1", item: "A1" },
} as const;

export function renderCoretaxXml(
  slipType: CoretaxSlipType,
  withholder: CoretaxWithholder,
  records: readonly CoretaxRecord[],
): string {
  const meta = DOCUMENT[slipType];
  const lines = [
    `<?xml version="1.${"0"}" encoding="UTF-8"?>`,
    `<${meta.root} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    element(1, "TIN", withholder.npwp),
    tag(1, `<${meta.list}>`),
  ];
  for (const record of records) {
    if (record.slipType !== slipType) {
      throw new Error("Refusing to emit a slip that failed preflight.");
    }
    lines.push(tag(2, `<${meta.item}>`));
    lines.push(...fieldsFor(record));
    lines.push(tag(2, `</${meta.item}>`));
  }
  lines.push(tag(1, `</${meta.list}>`));
  lines.push(`</${meta.root}>`);
  return `${lines.join("\n")}\n`;
}

function fieldsFor(record: CoretaxRecord): string[] {
  switch (record.slipType) {
    case "BPMP":
      return bpmpFields(record);
    case "BP21":
      return bp21Fields(record);
    case "BP26":
      return bp26Fields(record);
    case "BPA1":
      return bpa1Fields(record);
    default: {
      const unexpected: never = record;
      throw new Error(`Refusing to emit a slip that failed preflight: ${String(unexpected)}`);
    }
  }
}

function bpmpFields(record: BpmpRecord): string[] {
  return [
    element(3, "TaxPeriodMonth", String(record.taxPeriodMonth)),
    element(3, "TaxPeriodYear", String(record.taxPeriodYear)),
    element(3, "CounterpartOpt", record.counterpartOpt),
    passport(record.passportNumber),
    element(3, "CounterpartTin", record.nik),
    element(3, "StatusTaxExemption", record.ptkpStatus),
    element(3, "Position", record.position),
    element(3, "TaxCertificate", record.taxCertificate),
    element(3, "TaxObjectCode", record.taxObjectCode),
    element(3, "Gross", record.grossIdr.toString()),
    element(3, "Rate", percent(record.rate, "rate")),
    element(3, "IDPlaceOfBusinessActivity", record.nitku),
    element(3, "WithholdingDate", record.withholdingDate),
  ];
}

function bp21Fields(record: Bp21Record): string[] {
  return [
    element(3, "TaxPeriodMonth", String(record.taxPeriodMonth)),
    element(3, "TaxPeriodYear", String(record.taxPeriodYear)),
    element(3, "CounterpartTin", record.nik),
    element(3, "IDPlaceOfBusinessActivityOfIncomeRecipient", record.recipientNitku),
    element(3, "StatusTaxExemption", record.ptkpStatus),
    element(3, "TaxCertificate", record.taxCertificate),
    element(3, "TaxObjectCode", record.taxObjectCode),
    element(3, "Gross", record.grossIdr.toString()),
    element(3, "Deemed", percent(record.deemed, "deemed")),
    element(3, "Rate", percent(record.rate, "rate")),
    element(3, "Document", record.document),
    element(3, "DocumentNumber", record.documentNumber),
    element(3, "DocumentDate", record.documentDate),
    element(3, "IDPlaceOfBusinessActivity", record.nitku),
    element(3, "WithholdingDate", record.withholdingDate),
  ];
}

function bp26Fields(record: Bp26Record): string[] {
  return [
    element(3, "TaxPeriodMonth", String(record.taxPeriodMonth)),
    element(3, "TaxPeriodYear", String(record.taxPeriodYear)),
    element(3, "CounterpartTin", record.nik),
    element(3, "CounterpartName", record.name),
    element(3, "CounterpartCountry", record.countryCode),
    element(3, "CounterpartAddress", record.address),
    element(3, "CounterpartBirthPlace", record.birthPlace),
    element(3, "CounterpartBirthDate", record.birthDate),
    element(3, "CounterpartPassport", record.passportNumber),
    element(3, "TaxCertificate", record.taxCertificate),
    element(3, "TaxObjectCode", record.taxObjectCode),
    element(3, "Gross", record.grossIdr.toString()),
    element(3, "Deemed", percent(record.deemed, "deemed")),
    element(3, "Rate", percent(record.rate, "rate")),
    element(3, "Document", record.document),
    element(3, "DocumentNumber", record.documentNumber),
    element(3, "DocumentDate", record.documentDate),
    element(3, "IDPlaceOfBusinessActivity", record.nitku),
    element(3, "WithholdingDate", record.withholdingDate),
  ];
}

function bpa1Fields(record: Bpa1Record): string[] {
  const amounts = record.amounts;
  return [
    element(3, "TaxPeriodMonthStart", String(record.taxPeriodMonthStart)),
    element(3, "TaxPeriodMonthEnd", String(record.taxPeriodMonthEnd)),
    element(3, "TaxPeriodYear", String(record.taxPeriodYear)),
    element(3, "CounterpartOpt", record.counterpartOpt),
    passport(record.passportNumber),
    element(3, "CounterpartTin", record.nik),
    element(3, "StatusTaxExemption", record.ptkpStatus),
    element(3, "Position", record.position),
    element(3, "TaxObjectCode", record.taxObjectCode),
    element(3, "SlipStatus", record.slipStatus),
    element(3, "NextEmployer", record.nextEmployer),
    element(3, "Gross", amounts.grossIdr.toString()),
    element(3, "PositionCost", amounts.positionCostIdr.toString()),
    element(3, "PensionContribution", amounts.pensionContributionIdr.toString()),
    element(3, "Zakat", amounts.zakatIdr.toString()),
    element(3, "NetIncome", amounts.netIncomeIdr.toString()),
    element(3, "PreviousNetIncome", amounts.previousNetIncomeIdr.toString()),
    element(3, "Ptkp", amounts.ptkpIdr.toString()),
    element(3, "TaxableIncome", amounts.taxableIncomeIdr.toString()),
    element(3, "Article17Tax", amounts.article17TaxIdr.toString()),
    element(3, "PreviousWithholding", amounts.previousWithholdingIdr.toString()),
    element(3, "IncomeTax", amounts.incomeTaxIdr.toString()),
    element(3, "IncomeTaxPayable", amounts.incomeTaxPayableIdr.toString()),
    element(3, "IDPlaceOfBusinessActivity", record.nitku),
    element(3, "WithholdingDate", record.withholdingDate),
  ];
}

function passport(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return nilElement(3, "CounterpartPassport");
  return element(3, "CounterpartPassport", value);
}

function percent(rate: ScaledRate, field: string): string {
  const text = formatScaledPercent(rate.ratePerScale, rate.rateScale);
  if (text === null) throw new Error(`${field} failed preflight but was rendered.`);
  return text;
}

function element(indent: number, name: string, value: string): string {
  assertName(name);
  return `${"  ".repeat(indent)}<${name}>${escapeXml(value)}</${name}>`;
}

function nilElement(indent: number, name: string): string {
  assertName(name);
  return `${"  ".repeat(indent)}<${name} xsi:nil="true"/>`;
}

function tag(indent: number, line: string): string {
  return `${"  ".repeat(indent)}${line}`;
}

function assertName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error("XML element name is not safe.");
  }
}
