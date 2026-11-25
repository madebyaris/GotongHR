import type { Bpa1Record, Bp21Record, Bp26Record, BpmpRecord, CoretaxWithholder } from "../coretax/index.ts";
import { rupiah } from "../money.ts";

export const withholder: CoretaxWithholder = {
  npwp: "0102030405060708",
  nitku: "0102030405060708000001",
};

export const sitiNik = "3174011501900001";
export const budiNik = "3174011501900002";

const rateTwoPercent = { ratePerScale: 200n, rateScale: 10000n } as const;
const rateOnePointSevenFive = { ratePerScale: 175n, rateScale: 10000n } as const;
const deemedHalf = { ratePerScale: 5000n, rateScale: 10000n } as const;

export function bpmp(overrides: Partial<BpmpRecord> = {}): BpmpRecord {
  return {
    employeeId: "siti",
    nik: sitiNik,
    name: "Siti Aminah",
    ptkpStatus: "TK/0",
    nitku: withholder.nitku,
    taxPeriodYear: 2026,
    taxPeriodMonth: 1,
    withholdingDate: "2026-01-31",
    taxObjectCode: "21-100-01",
    counterpartOpt: "Resident",
    passportNumber: "",
    position: "Staff",
    taxCertificate: "N/A",
    grossIdr: rupiah(8_000_000n),
    rate: rateOnePointSevenFive,
    ...overrides,
    slipType: "BPMP",
  };
}

export function bp21(overrides: Partial<Bp21Record> = {}): Bp21Record {
  const nik = overrides.nik ?? sitiNik;
  return {
    employeeId: "siti",
    name: "Siti Aminah",
    ptkpStatus: "TK/0",
    nitku: withholder.nitku,
    taxPeriodYear: 2026,
    taxPeriodMonth: 1,
    withholdingDate: "2026-01-31",
    taxObjectCode: "21-100-03",
    taxCertificate: "N/A",
    grossIdr: rupiah(5_000_000n),
    deemed: deemedHalf,
    rate: rateTwoPercent,
    document: "CommercialInvoice",
    documentNumber: "INV-1",
    documentDate: "2026-01-15",
    ...overrides,
    slipType: "BP21",
    nik,
    recipientNitku: overrides.recipientNitku ?? `${nik}000000`,
  };
}

export function bp26(overrides: Partial<Bp26Record> = {}): Bp26Record {
  return {
    employeeId: "wira",
    nik: "0102030405060799",
    name: "Wira Tan",
    ptkpStatus: "TK/0",
    nitku: withholder.nitku,
    taxPeriodYear: 2026,
    taxPeriodMonth: 1,
    withholdingDate: "2026-01-31",
    taxObjectCode: "27-100-99",
    countryCode: "SGP",
    address: "1 Orchard Road",
    birthPlace: "Singapore",
    birthDate: "1990-01-15",
    passportNumber: "A1234567",
    taxCertificate: "N/A",
    grossIdr: rupiah(12_000_000n),
    deemed: deemedHalf,
    rate: rateTwoPercent,
    document: "CommercialInvoice",
    documentNumber: "INV-26",
    documentDate: "2026-01-15",
    ...overrides,
    slipType: "BP26",
  };
}

export function bpa1(overrides: Partial<Bpa1Record> = {}): Bpa1Record {
  return {
    employeeId: "siti",
    nik: sitiNik,
    name: "Siti Aminah",
    ptkpStatus: "K/1",
    nitku: withholder.nitku,
    taxPeriodYear: 2026,
    taxObjectCode: "21-100-01",
    withholdingDate: "2026-12-31",
    taxPeriodMonthStart: 1,
    taxPeriodMonthEnd: 12,
    counterpartOpt: "Resident",
    passportNumber: "",
    position: "Staff",
    slipStatus: "FullYear",
    nextEmployer: "No",
    amounts: {
      grossIdr: rupiah(100_000_000n),
      positionCostIdr: rupiah(5_000_000n),
      pensionContributionIdr: rupiah(2_000_000n),
      zakatIdr: rupiah(0n),
      netIncomeIdr: rupiah(93_000_000n),
      previousNetIncomeIdr: rupiah(0n),
      ptkpIdr: rupiah(54_000_000n),
      taxableIncomeIdr: rupiah(39_000_000n),
      article17TaxIdr: rupiah(1_950_000n),
      previousWithholdingIdr: rupiah(1_800_000n),
      incomeTaxIdr: rupiah(1_950_000n),
      incomeTaxPayableIdr: rupiah(150_000n),
    },
    ...overrides,
    slipType: "BPA1",
  };
}
