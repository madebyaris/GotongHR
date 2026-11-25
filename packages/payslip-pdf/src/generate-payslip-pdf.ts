import { randomBytes } from "node:crypto";
import PDFDocument from "pdfkit";
import { bilingual, formatIdr, formatPayslipPeriod, maskNik } from "./format.ts";
import { assertPayslipPassword } from "./password.ts";
import type {
  PayslipAmountLine,
  PayslipBpjsBreakdown,
  PayslipDto,
  Pph21Method,
} from "./types.ts";

const MARGIN_X = 40;
const MARGIN_Y = 36;
const INK = "#1c1917";
const MUTED = "#57534e";
const RULE = "#d6d3d1";

const PPH21_METHOD_LABEL: Record<Pph21Method, string> = {
  gross: "Gross",
  nett: "Nett",
  gross_up: "Gross-up",
};

const BPJS_ROWS: ReadonlyArray<{
  label: string;
  employee: keyof PayslipBpjsBreakdown | null;
  employer: keyof PayslipBpjsBreakdown;
}> = [
  {
    label: "Kesehatan / Health",
    employee: "kesehatanEmployeeIdr",
    employer: "kesehatanEmployerIdr",
  },
  { label: "JHT", employee: "jhtEmployeeIdr", employer: "jhtEmployerIdr" },
  { label: "JKK", employee: null, employer: "jkkEmployerIdr" },
  { label: "JKM", employee: null, employer: "jkmEmployerIdr" },
  { label: "JP", employee: "jpEmployeeIdr", employer: "jpEmployerIdr" },
  { label: "JKP", employee: null, employer: "jkpEmployerIdr" },
];

const WATERMARK = "DRAFT / UNDECLARED STATUTORY TABLE";

/**
 * Builds one AES-256 password-protected payslip PDF.
 * `password` is the user password. An empty or whitespace password throws.
 * This function does not read a database, the network, or object storage.
 */
export function generatePayslipPdf(payslip: PayslipDto, password: string): Promise<Uint8Array> {
  assertPayslipPassword(password);
  assertPayslip(payslip);
  const ownerPassword = randomOwnerPassword(password);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      pdfVersion: "1.7ext3",
      userPassword: password,
      ownerPassword,
      permissions: {
        printing: "highResolution",
        modifying: false,
        copying: false,
        annotating: false,
        fillingForms: false,
        contentAccessibility: true,
        documentAssembly: false,
      },
      size: "A4",
      margin: MARGIN_Y,
      compress: true,
      info: {
        Title: "Slip Gaji / Payslip",
      },
      lang: "id",
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    doc.on("error", reject);
    doc.on("end", () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    try {
      drawPayslip(doc, payslip);
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Payslip PDF failed."));
    }
  });
}

function randomOwnerPassword(userPassword: string): string {
  let owner = randomBytes(32).toString("base64url");
  if (owner === userPassword) {
    owner = `${owner}o`;
  }
  return owner;
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - MARGIN_X * 2;
}

function drawPayslip(doc: PDFKit.PDFDocument, payslip: PayslipDto): void {
  drawWatermark(doc, payslip.tableUndeclared);
  let y = MARGIN_Y;
  y = drawHeader(doc, payslip, y);
  y = drawEmployee(doc, payslip, y);
  y = drawAmountSection(
    doc,
    payslip,
    y,
    "PENGHASILAN / EARNINGS",
    "Jumlah penghasilan / Total earnings",
    payslip.earnings,
  );
  y = drawAmountSection(
    doc,
    payslip,
    y,
    "POTONGAN / DEDUCTIONS",
    "Jumlah potongan / Total deductions",
    payslip.deductions,
  );
  y = drawBpjs(doc, payslip, y);
  drawNet(doc, payslip, y);
}

function drawWatermark(doc: PDFKit.PDFDocument, enabled: boolean): void {
  if (!enabled) {
    return;
  }
  doc.save();
  doc.opacity(0.16);
  doc.translate(doc.page.width / 2, 340);
  doc.rotate(-30);
  doc.font("Helvetica-Bold").fontSize(22).fillColor(MUTED);
  doc.text(WATERMARK, -250, -10, { width: 500, align: "center", lineBreak: false });
  doc.restore();
  doc.opacity(1);
}

function ensureSpace(
  doc: PDFKit.PDFDocument,
  y: number,
  height: number,
  watermark: boolean,
): number {
  if (y + height <= doc.page.height - MARGIN_Y) {
    return y;
  }
  doc.addPage();
  drawWatermark(doc, watermark);
  return MARGIN_Y;
}

function sectionLabel(doc: PDFKit.PDFDocument, y: number, label: string): number {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  doc.text(label, MARGIN_X, y, { width: contentWidth(doc), lineBreak: false });
  return y + 14;
}

function hairline(doc: PDFKit.PDFDocument, y: number): number {
  const width = contentWidth(doc);
  doc.save();
  doc
    .strokeColor(RULE)
    .lineWidth(0.6)
    .moveTo(MARGIN_X, y)
    .lineTo(MARGIN_X + width, y)
    .stroke();
  doc.restore();
  return y + 6;
}

function amountLayout(doc: PDFKit.PDFDocument): {
  width: number;
  amountWidth: number;
  labelWidth: number;
} {
  const width = contentWidth(doc);
  const amountWidth = 120;
  return { width, amountWidth, labelWidth: width - amountWidth - 12 };
}

function amountRowHeight(doc: PDFKit.PDFDocument, label: string, emphasis: boolean): number {
  const { labelWidth } = amountLayout(doc);
  doc.font(emphasis ? "Helvetica-Bold" : "Helvetica").fontSize(9);
  return doc.heightOfString(label, { width: labelWidth }) + 3;
}

function amountRow(
  doc: PDFKit.PDFDocument,
  y: number,
  label: string,
  amount: string,
  emphasis: boolean,
): number {
  const { width, amountWidth, labelWidth } = amountLayout(doc);
  doc.font(emphasis ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(INK);
  const labelHeight = doc.heightOfString(label, { width: labelWidth });
  doc.text(label, MARGIN_X, y, { width: labelWidth });
  doc.text(amount, MARGIN_X + width - amountWidth, y, {
    width: amountWidth,
    align: "right",
    lineBreak: false,
  });
  return y + labelHeight + 3;
}

function drawHeader(doc: PDFKit.PDFDocument, payslip: PayslipDto, y: number): number {
  const width = contentWidth(doc);
  const rightWidth = 188;
  const leftWidth = width - rightWidth - 16;
  const top = y;

  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
  doc.text(formatPayslipPeriod(payslip.periodYear, payslip.periodMonth), MARGIN_X + leftWidth + 16, top, {
    width: rightWidth,
    align: "right",
    lineBreak: false,
  });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  doc.text("SLIP GAJI / PAYSLIP", MARGIN_X + leftWidth + 16, top + 16, {
    width: rightWidth,
    align: "right",
    lineBreak: false,
  });

  doc.font("Helvetica-Bold").fontSize(13).fillColor(INK);
  doc.text(payslip.legalEntityName, MARGIN_X, top, { width: leftWidth });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  doc.text(payslip.companyName, MARGIN_X, doc.y + 2, { width: leftWidth });
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  doc.text(`NPWP ${payslip.companyNpwp}`, MARGIN_X, doc.y + 2, { width: leftWidth });
  return hairline(doc, doc.y + 10);
}

function drawEmployee(doc: PDFKit.PDFDocument, payslip: PayslipDto, y: number): number {
  y = ensureSpace(doc, y, 78, payslip.tableUndeclared);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK);
  doc.text(payslip.employeeName, MARGIN_X, y, { width: contentWidth(doc), lineBreak: false });
  y += 22;
  y = metaRow(doc, y, "NIK", maskNik(payslip.employeeNik), "Jabatan / Title", payslip.jobTitle);
  y = metaRow(
    doc,
    y,
    "PTKP",
    payslip.ptkpStatus,
    "PPh 21",
    `${PPH21_METHOD_LABEL[payslip.pph21Method]} / ${payslip.pph21Status}`,
  );
  return y + 6;
}

function metaRow(
  doc: PDFKit.PDFDocument,
  y: number,
  leftLabel: string,
  leftValue: string,
  rightLabel: string,
  rightValue: string,
): number {
  const column = contentWidth(doc) / 2;
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  doc.text(leftLabel, MARGIN_X, y, { width: column - 12, lineBreak: false });
  doc.text(rightLabel, MARGIN_X + column, y, { width: column, lineBreak: false });
  doc.font("Helvetica").fontSize(10).fillColor(INK);
  doc.text(leftValue, MARGIN_X, y + 11, { width: column - 12, lineBreak: false });
  doc.text(rightValue, MARGIN_X + column, y + 11, { width: column, lineBreak: false });
  return y + 28;
}

function drawAmountSection(
  doc: PDFKit.PDFDocument,
  payslip: PayslipDto,
  y: number,
  title: string,
  totalLabel: string,
  lines: readonly PayslipAmountLine[],
): number {
  y = ensureSpace(doc, y, 32, payslip.tableUndeclared);
  y = sectionLabel(doc, y, title);
  let total = 0n;
  for (const line of lines) {
    const label = bilingual(line.labelId, line.labelEn);
    const rowHeight = amountRowHeight(doc, label, false);
    y = ensureSpace(doc, y, rowHeight, payslip.tableUndeclared);
    y = amountRow(doc, y, label, formatIdr(line.amountIdr), false);
    total += line.amountIdr;
  }
  y = hairline(doc, y);
  const totalHeight = amountRowHeight(doc, totalLabel, true);
  y = ensureSpace(doc, y, totalHeight, payslip.tableUndeclared);
  y = amountRow(doc, y, totalLabel, formatIdr(total), true);
  return y + 12;
}

function drawBpjs(doc: PDFKit.PDFDocument, payslip: PayslipDto, y: number): number {
  y = ensureSpace(doc, y, 52, payslip.tableUndeclared);
  y = sectionLabel(doc, y, "RINCIAN BPJS / BPJS BREAKDOWN");
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  const noteWidth = contentWidth(doc);
  const lineHeight = doc.currentLineHeight();
  doc.text("Kolom perusahaan tidak dipotong dari gaji bersih.", MARGIN_X, y, {
    width: noteWidth,
    lineBreak: false,
  });
  doc.text("The employer column is not deducted from take-home pay.", MARGIN_X, y + lineHeight, {
    width: noteWidth,
    lineBreak: false,
  });
  y += lineHeight * 2 + 8;
  y = ensureSpace(doc, y, 16, payslip.tableUndeclared);
  y = bpjsRow(doc, y, "", "Karyawan / Employee", "Perusahaan / Employer", true);
  for (const row of BPJS_ROWS) {
    y = ensureSpace(doc, y, 16, payslip.tableUndeclared);
    const employee = row.employee === null ? "-" : formatIdr(payslip.bpjs[row.employee]);
    y = bpjsRow(doc, y, row.label, employee, formatIdr(payslip.bpjs[row.employer]), false);
  }
  return y + 14;
}

function bpjsRow(
  doc: PDFKit.PDFDocument,
  y: number,
  label: string,
  employee: string,
  employer: string,
  header: boolean,
): number {
  const width = contentWidth(doc);
  const columnWidth = 120;
  const employerX = MARGIN_X + width - columnWidth;
  const employeeX = employerX - columnWidth - 8;
  doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? 8 : 9);
  doc.fillColor(header ? MUTED : INK);
  doc.text(label, MARGIN_X, y, { width: employeeX - MARGIN_X - 8, lineBreak: false });
  doc.text(employee, employeeX, y, { width: columnWidth, align: "right", lineBreak: false });
  doc.text(employer, employerX, y, { width: columnWidth, align: "right", lineBreak: false });
  return y + 14;
}

function drawNet(doc: PDFKit.PDFDocument, payslip: PayslipDto, y: number): void {
  y = ensureSpace(doc, y, 56, payslip.tableUndeclared);
  const width = contentWidth(doc);
  const amountWidth = 170;
  doc.save();
  doc.rect(MARGIN_X - 4, y - 4, width + 8, 52).fill("#ffffff");
  doc.restore();
  y = hairline(doc, y);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  doc.text("DITERIMA / TAKE-HOME PAY", MARGIN_X, y + 8, {
    width: width - amountWidth - 12,
    lineBreak: false,
  });
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK);
  doc.text(formatIdr(payslip.netPayIdr), MARGIN_X + width - amountWidth, y, {
    width: amountWidth,
    align: "right",
    lineBreak: false,
  });
}

const PPH21_METHODS: readonly Pph21Method[] = ["gross", "nett", "gross_up"];

function assertPayslip(payslip: PayslipDto): void {
  if (payslip === null || typeof payslip !== "object") {
    throw new TypeError("Payslip must be an object.");
  }
  requiredText(payslip.companyName, "Company name");
  requiredText(payslip.companyNpwp, "Company NPWP");
  requiredText(payslip.legalEntityName, "Legal entity");
  requiredText(payslip.employeeName, "Employee name");
  requiredText(payslip.jobTitle, "Job title");
  requiredText(payslip.ptkpStatus, "PTKP");
  requiredText(payslip.pph21Status, "PPh 21 status");
  maskNik(payslip.employeeNik);
  requiredInt(payslip.periodYear, "Period year", 1900, 2200);
  requiredInt(payslip.periodMonth, "Period month", 1, 12);
  if (!PPH21_METHODS.includes(payslip.pph21Method)) {
    throw new TypeError("PPh 21 method must be gross, nett, or gross_up.");
  }
  if (typeof payslip.tableUndeclared !== "boolean") {
    throw new TypeError("tableUndeclared must be a boolean.");
  }
  assertLines(payslip.earnings, "Earnings");
  assertLines(payslip.deductions, "Deductions");
  assertIdr(payslip.netPayIdr, "Net pay");
  assertBpjs(payslip.bpjs);
}

function assertLines(lines: readonly PayslipAmountLine[], field: string): void {
  if (!Array.isArray(lines)) {
    throw new TypeError(`${field} must be a list.`);
  }
  for (const line of lines) {
    requiredText(line?.labelId, `${field} label`);
    requiredText(line?.labelEn, `${field} English label`);
    assertIdr(line.amountIdr, `${field} amount`);
  }
}

function assertBpjs(bpjs: PayslipBpjsBreakdown): void {
  if (bpjs === null || typeof bpjs !== "object") {
    throw new TypeError("BPJS breakdown must be an object.");
  }
  const amounts: ReadonlyArray<[bigint, string]> = [
    [bpjs.kesehatanEmployeeIdr, "BPJS Kesehatan employee"],
    [bpjs.jhtEmployeeIdr, "BPJS JHT employee"],
    [bpjs.jpEmployeeIdr, "BPJS JP employee"],
    [bpjs.kesehatanEmployerIdr, "BPJS Kesehatan employer"],
    [bpjs.jhtEmployerIdr, "BPJS JHT employer"],
    [bpjs.jkkEmployerIdr, "BPJS JKK employer"],
    [bpjs.jkmEmployerIdr, "BPJS JKM employer"],
    [bpjs.jpEmployerIdr, "BPJS JP employer"],
    [bpjs.jkpEmployerIdr, "BPJS JKP employer"],
  ];
  for (const [amount, field] of amounts) {
    assertIdr(amount, field);
  }
}

function requiredText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function requiredInt(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer from ${min} to ${max}.`);
  }
}

function assertIdr(value: bigint, field: string): void {
  if (typeof value !== "bigint") {
    throw new TypeError(`${field} must be bigint rupiah.`);
  }
}
