import { createHash } from "node:crypto";
import { idr, type Idr } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { MissingStatutoryValueError, PayrollInputError } from "@gotonghr/payroll-engine";
import { generatePayslipPdf, passwordFromDateOfBirth, type PayslipDto } from "@gotonghr/payslip-pdf";
import { sql } from "drizzle-orm";
import {
  attendanceFromSnapshot,
  computePayItem,
  profileFromSnapshot,
  readStatutoryTable,
  type StoredBpjs,
  type StoredDeductions,
  type StoredEarnings,
  type StoredPph21,
} from "./calculate.ts";
import { PayrollError } from "./errors.ts";
import type { PayrollCalcMessage, PayrollPdfMessage, PayrollStoragePort } from "./ports.ts";
import { asJson, jsonText, queryRows } from "./sql.ts";

export async function processPayrollCalculation(
  deps: { appDb: TenantDatabase },
  message: PayrollCalcMessage,
): Promise<void> {
  const table = readStatutoryTable(message.tablePayload);
  const first = message.employees[0];
  const year = wholeField(first?.attendance.periodYear, "periodYear");
  const month = wholeField(first?.attendance.periodMonth, "periodMonth");
  const lines = message.employees.map((employee) => {
    const profile = profileFromSnapshot(employee.profile);
    const attendance = attendanceFromSnapshot(employee.attendance);
    try {
      return {
        profile,
        pay: computePayItem({ profile, attendance, table, periodYear: year, periodMonth: month }),
      };
    } catch (error) {
      if (error instanceof PayrollInputError || error instanceof MissingStatutoryValueError) {
        throw new PayrollError(422, "payroll_input", error.message);
      }
      throw error;
    }
  });
  await deps.appDb.withTenantContext(message.tenantId, async (tx) => {
    for (const line of lines) {
      await tx.execute(sql`
        INSERT INTO pay_run_items (
          tenant_id, run_id, employee_id, owner_user_id,
          employee_snapshot_json, attendance_snapshot_json,
          earnings_json, deductions_json, bpjs_json, pph21_json,
          gross_idr, tax_idr, net_idr
        ) VALUES (
          ${message.tenantId}::uuid,
          ${message.runId}::uuid,
          ${line.profile.employeeId}::uuid,
          CASE WHEN ${line.profile.userId}::text IS NULL THEN NULL ELSE ${line.profile.userId}::uuid END,
          ${jsonText(line.pay.employeeSnapshot)}::jsonb,
          ${jsonText(line.pay.attendanceSnapshot)}::jsonb,
          ${jsonText(line.pay.earnings)}::jsonb,
          ${jsonText(line.pay.deductions)}::jsonb,
          ${jsonText(line.pay.bpjs)}::jsonb,
          ${jsonText(line.pay.pph21)}::jsonb,
          ${line.pay.grossIdr.toString()}::bigint,
          ${line.pay.taxIdr.toString()}::bigint,
          ${line.pay.netIdr.toString()}::bigint
        )
        ON CONFLICT (tenant_id, run_id, employee_id) DO NOTHING
      `);
    }
    await markBatch(tx, message);
  });
}

async function markBatch(tx: TenantTx, message: PayrollCalcMessage): Promise<void> {
  await tx.execute(sql`
    SELECT id FROM pay_runs WHERE id = ${message.runId}::uuid FOR UPDATE
  `);
  await tx.execute(sql`
    UPDATE pay_runs
    SET calc_completed_batches = array_append(calc_completed_batches, ${message.batchIndex}),
        status = CASE
          WHEN cardinality(calc_completed_batches) + 1 = calc_batch_total THEN 'calculated'
          ELSE status
        END,
        total_gross_idr = CASE
          WHEN cardinality(calc_completed_batches) + 1 = calc_batch_total THEN (
            SELECT COALESCE(SUM(gross_idr), 0) FROM pay_run_items
            WHERE run_id = pay_runs.id AND tenant_id = pay_runs.tenant_id
          )
          ELSE total_gross_idr
        END,
        total_tax_idr = CASE
          WHEN cardinality(calc_completed_batches) + 1 = calc_batch_total THEN (
            SELECT COALESCE(SUM(tax_idr), 0) FROM pay_run_items
            WHERE run_id = pay_runs.id AND tenant_id = pay_runs.tenant_id
          )
          ELSE total_tax_idr
        END,
        total_net_idr = CASE
          WHEN cardinality(calc_completed_batches) + 1 = calc_batch_total THEN (
            SELECT COALESCE(SUM(net_idr), 0) FROM pay_run_items
            WHERE run_id = pay_runs.id AND tenant_id = pay_runs.tenant_id
          )
          ELSE total_net_idr
        END,
        updated_at = now()
    WHERE id = ${message.runId}::uuid
      AND status = 'draft'
      AND NOT (${message.batchIndex} = ANY (calc_completed_batches))
  `);
}

export async function processPayrollPayslips(
  deps: { appDb: TenantDatabase; storage: PayrollStoragePort },
  message: PayrollPdfMessage,
): Promise<void> {
  const run = await deps.appDb.withTenantContext(message.tenantId, async (tx) => loadRunPeriod(tx, message.runId));
  for (const itemId of message.itemIds) {
    const item = await deps.appDb.withTenantContext(message.tenantId, async (tx) => loadItem(tx, itemId));
    if (!item || item.payslip_storage_key) continue;
    const pdf = await generatePayslipPdf(payslipOf(item, run), passwordFromDateOfBirth(textField(item.employee, "dateOfBirth")));
    const key = `payslips/${message.tenantId}/${message.runId}/${itemId}.pdf`;
    await deps.storage.put({ key, body: pdf, contentType: "application/pdf" });
    await deps.appDb.withTenantContext(message.tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE pay_run_items
        SET payslip_storage_key = ${key},
            payslip_generated_at = now(),
            updated_at = now()
        WHERE id = ${itemId}::uuid
          AND payslip_storage_key IS NULL
      `);
    });
  }
}

export function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

interface RunPeriod {
  year: number;
  month: number;
}

interface ItemFile {
  payslip_storage_key: string | null;
  employee: Record<string, unknown>;
  earnings: StoredEarnings;
  deductions: StoredDeductions;
  bpjs: StoredBpjs;
  pph21: StoredPph21;
  net_idr: string;
}

async function loadRunPeriod(tx: TenantTx, runId: string): Promise<RunPeriod> {
  const rows = queryRows<{ period_year_month: string }>(
    await tx.execute(sql`
      SELECT period_year_month FROM pay_runs WHERE id = ${runId}::uuid
    `),
  );
  const period = rows[0]?.period_year_month;
  if (!period) throw new PayrollError(404, "not_found", "Payroll run was not found.");
  const [yearText, monthText] = period.split("-");
  return { year: Number(yearText), month: Number(monthText) };
}

async function loadItem(tx: TenantTx, itemId: string): Promise<ItemFile | null> {
  const rows = queryRows<{
    payslip_storage_key: string | null;
    employee_snapshot_json: unknown;
    earnings_json: unknown;
    deductions_json: unknown;
    bpjs_json: unknown;
    pph21_json: unknown;
    net_idr: string;
  }>(
    await tx.execute(sql`
      SELECT payslip_storage_key,
             employee_snapshot_json,
             earnings_json,
             deductions_json,
             bpjs_json,
             pph21_json,
             net_idr::text AS net_idr
      FROM pay_run_items
      WHERE id = ${itemId}::uuid
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    payslip_storage_key: row.payslip_storage_key,
    employee: record(row.employee_snapshot_json),
    earnings: record(row.earnings_json) as unknown as StoredEarnings,
    deductions: record(row.deductions_json) as unknown as StoredDeductions,
    bpjs: record(row.bpjs_json) as unknown as StoredBpjs,
    pph21: record(row.pph21_json) as unknown as StoredPph21,
    net_idr: row.net_idr,
  };
}

function payslipOf(item: ItemFile, run: RunPeriod): PayslipDto {
  const method = item.pph21.method;
  if (method !== "gross" && method !== "nett" && method !== "gross_up") {
    throw new PayrollError(500, "internal_error", "Stored tax method is not gross, nett, or gross_up.");
  }
  const earnings = [
    line("Gaji pokok", "Base salary", item.earnings.baseSalaryIdr),
    line("Tunjangan tetap", "Fixed allowances", item.earnings.fixedAllowancesIdr),
    line("Lembur", "Overtime", item.earnings.overtimeIdr),
    line("Tunjangan pajak", "Tax allowance", item.earnings.taxAllowanceIdr),
  ].filter((entry) => entry.amountIdr > 0n);
  const deductions = [
    line("BPJS karyawan", "Employee BPJS", item.deductions.bpjsEmployeeIdr),
    line("PPh 21", "PPh 21", item.deductions.pph21EmployeeIdr),
  ].filter((entry) => entry.amountIdr > 0n);
  return {
    companyName: textField(item.employee, "companyName"),
    companyNpwp: textField(item.employee, "companyNpwp"),
    legalEntityName: textField(item.employee, "companyName"),
    periodYear: run.year,
    periodMonth: run.month,
    employeeName: textField(item.employee, "fullName"),
    employeeNik: textField(item.employee, "nik"),
    jobTitle: textField(item.employee, "jobTitle"),
    ptkpStatus: textField(item.employee, "ptkpStatus"),
    earnings,
    deductions,
    pph21Method: method,
    pph21Status: item.pph21.tableStatus,
    tableUndeclared: item.pph21.tableUndeclared === true,
    bpjs: {
      kesehatanEmployeeIdr: money(item.bpjs.kesehatanEmployeeIdr),
      jhtEmployeeIdr: money(item.bpjs.jhtEmployeeIdr),
      jpEmployeeIdr: money(item.bpjs.jpEmployeeIdr),
      kesehatanEmployerIdr: money(item.bpjs.kesehatanEmployerIdr),
      jhtEmployerIdr: money(item.bpjs.jhtEmployerIdr),
      jkkEmployerIdr: money(item.bpjs.jkkEmployerIdr),
      jkmEmployerIdr: money(item.bpjs.jkmEmployerIdr),
      jpEmployerIdr: money(item.bpjs.jpEmployerIdr),
      jkpEmployerIdr: money(item.bpjs.jkpEmployerIdr),
    },
    netPayIdr: money(item.net_idr),
  };
}

function line(labelId: string, labelEn: string, amount: string): { labelId: string; labelEn: string; amountIdr: Idr } {
  return { labelId, labelEn, amountIdr: idr(money(amount)) };
}

function record(value: unknown): Record<string, unknown> {
  const parsed = asJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PayrollError(500, "internal_error", "Stored payroll JSON was not an object.");
  }
  return parsed as Record<string, unknown>;
}

function textField(recordValue: Record<string, unknown>, key: string): string {
  const value = recordValue[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PayrollError(500, "internal_error", `${key} is missing from the payslip snapshot.`);
  }
  return value;
}

function money(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new PayrollError(500, "internal_error", "Stored rupiah was not an integer.");
  }
  return BigInt(value);
}

function wholeField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PayrollError(500, "internal_error", `${label} was not a whole number.`);
  }
  return value;
}
