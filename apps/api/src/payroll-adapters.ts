import { readTenantSecrets } from "@gotonghr/audit";
import { idr, type AttendancePayrollPort, type BpjsFlags, type CoreHrPayrollPort, type EmployeePayrollProfileDTO, type StatutoryPayrollPort } from "@gotonghr/contracts";
import { decryptField } from "@gotonghr/crypto/decrypt";
import type { TenantDatabase } from "@gotonghr/db";
import { sql } from "drizzle-orm";

interface ProfileRow {
  employee_id: string;
  employee_code: string;
  full_name: string;
  legal_entity_id: string;
  branch_id: string;
  user_id: string | null;
  date_of_birth: string | null;
  ptkp_status: EmployeePayrollProfileDTO["ptkpStatus"];
  tax_method: EmployeePayrollProfileDTO["taxMethod"];
  pph21_subject_type: EmployeePayrollProfileDTO["pph21SubjectType"];
  job_title: string;
  base_salary_idr: string;
  fixed_allowances_json: unknown;
  bpjs_flags_json: unknown;
  company_name: string;
  npwp_16: string;
  jkk_risk_class: number;
  nitku_22: string;
  ump_umk_idr: string;
  nik_enc: string | null;
  bank_account_number_enc: string | null;
}

/**
 * In-process adapters. The payroll package does not import core HR or attendance.
 * NIK and bank numbers are decrypted here for the calculation snapshot.
 * The audit diff written by payroll does not include those values.
 */
export function createPayrollAdapters(appDb: TenantDatabase): {
  coreHr: CoreHrPayrollPort;
  attendance: AttendancePayrollPort;
  statutory: StatutoryPayrollPort;
} {
  return {
    coreHr: {
      async getActivePayrollProfiles(input) {
        const end = monthEnd(input.periodYear, input.periodMonth);
        return appDb.withTenantContext(input.tenantId, async (tx) => {
          const rows = queryRows<ProfileRow>(
            await tx.execute(sql`
              SELECT DISTINCT ON (e.id)
                e.id::text AS employee_id,
                e.employee_code,
                e.full_name,
                e.legal_entity_id::text AS legal_entity_id,
                e.branch_id::text AS branch_id,
                e.user_id::text AS user_id,
                e.date_of_birth::text AS date_of_birth,
                e.ptkp_status,
                e.tax_method,
                e.pph21_subject_type,
                COALESCE(pos.title, 'Staff') AS job_title,
                c.base_salary_idr::text AS base_salary_idr,
                c.fixed_allowances_json,
                c.bpjs_flags_json,
                le.company_name,
                le.npwp_16,
                COALESCE(le.jkk_risk_class, 1) AS jkk_risk_class,
                b.nitku_22,
                b.ump_umk_idr::text AS ump_umk_idr,
                p.nik_enc,
                p.bank_account_number_enc
              FROM hr_employees e
              JOIN hr_compensation_profiles c
                ON c.tenant_id = e.tenant_id
               AND c.employee_id = e.id
               AND c.effective_from <= ${end}::date
               AND (c.effective_to IS NULL OR c.effective_to >= ${end}::date)
              JOIN id_legal_entities le
                ON le.id = e.legal_entity_id AND le.tenant_id = e.tenant_id
              JOIN id_branches b
                ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
              LEFT JOIN hr_positions pos
                ON pos.id = e.position_id AND pos.tenant_id = e.tenant_id
              LEFT JOIN hr_employee_pii p
                ON p.employee_id = e.id AND p.tenant_id = e.tenant_id
              WHERE e.legal_entity_id = ${input.legalEntityId}::uuid
                AND e.employment_status IN ('active', 'probation')
              ORDER BY e.id, c.effective_from DESC
            `),
          );
          let dek: Buffer | null = null;
          try {
            dek = (await readTenantSecrets(tx, input.tenantId)).dek;
          } catch {
            dek = null;
          }
          return rows.map((row) => toProfile(input.tenantId, row, dek));
        });
      },
      async employeeIdForUser(input) {
        return appDb.withTenantContext(input.tenantId, async (tx) => {
          const rows = queryRows<{ id: string }>(
            await tx.execute(sql`
              SELECT id::text AS id
              FROM hr_employees
              WHERE user_id = ${input.userId}::uuid
              LIMIT 1
            `),
          );
          return rows[0]?.id ?? null;
        });
      },
    },
    attendance: {
      async getLockedPeriodSummaries(input) {
        const start = monthStart(input.periodYear, input.periodMonth);
        const end = monthEnd(input.periodYear, input.periodMonth);
        return appDb.withTenantContext(input.tenantId, async (tx) => {
          const rows = queryRows<{ employee_id: string; minutes: number; locked: boolean; days: number }>(
            await tx.execute(sql`
              SELECT e.id::text AS employee_id,
                     COALESCE(SUM(s.approved_overtime_minutes), 0)::int AS minutes,
                     COALESCE(BOOL_AND(s.is_locked), false) AS locked,
                     COUNT(s.id)::int AS days
              FROM hr_employees e
              LEFT JOIN att_daily_summaries s
                ON s.employee_id = e.id
               AND s.tenant_id = e.tenant_id
               AND s.work_date >= ${start}::date
               AND s.work_date <= ${end}::date
              WHERE e.legal_entity_id = ${input.legalEntityId}::uuid
                AND e.employment_status IN ('active', 'probation')
              GROUP BY e.id
            `),
          );
          return rows.map((row) => ({
            tenantId: input.tenantId,
            employeeId: row.employee_id,
            legalEntityId: input.legalEntityId,
            periodYear: input.periodYear,
            periodMonth: input.periodMonth,
            approvedOvertimeMinutes: Number(row.minutes),
            locked: Number(row.days) > 0 && row.locked === true,
          }));
        });
      },
      async attachPayrollRun(input) {
        const start = monthStart(input.periodYear, input.periodMonth);
        const end = monthEnd(input.periodYear, input.periodMonth);
        return appDb.withTenantContext(input.tenantId, async (tx) => {
          const updated = await tx.execute(sql`
            UPDATE att_daily_summaries AS s
            SET locked_for_payroll_run_id = ${input.runId}::uuid,
                updated_at = now()
            FROM hr_employees AS e
            WHERE s.employee_id = e.id
              AND s.tenant_id = e.tenant_id
              AND e.legal_entity_id = ${input.legalEntityId}::uuid
              AND s.work_date >= ${start}::date
              AND s.work_date <= ${end}::date
              AND s.is_locked = true
              AND (s.locked_for_payroll_run_id IS NULL OR s.locked_for_payroll_run_id = ${input.runId}::uuid)
          `);
          return { attached: rowCount(updated) };
        });
      },
    },
    statutory: {
      async getEffectiveTable(input) {
        return appDb.withTenantContext(publishedTenant(input.payrollDate), async (tx) => {
          const rows = queryRows<{ id: string; payload_json: unknown }>(
            await tx.execute(sql`
              SELECT id::text AS id, payload_json
              FROM pay_statutory_tables
              WHERE rule_type = 'pph21'
                AND status = 'published'
                AND effective_from <= ${input.payrollDate}::date
                AND (effective_to IS NULL OR effective_to >= ${input.payrollDate}::date)
              ORDER BY effective_from DESC
            `),
          );
          if (rows.length > 1) throw new Error("Overlapping published statutory tables cover this date.");
          const row = rows[0];
          if (!row) return null;
          return { id: row.id, payload: row.payload_json };
        });
      },
    },
  };
}

/**
 * Statutory tables have no tenant. The read still runs inside a tenant transaction
 * so the app role's published-row policy applies. The id is not stored on the table.
 */
function publishedTenant(payrollDate: string): string {
  void payrollDate;
  return "00000000-0000-7000-8000-000000000001";
}

function toProfile(tenantId: string, row: ProfileRow, dek: Buffer | null): EmployeePayrollProfileDTO {
  return {
    tenantId,
    employeeId: row.employee_id,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
    userId: row.user_id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    jobTitle: row.job_title,
    dateOfBirth: row.date_of_birth ?? "",
    ptkpStatus: row.ptkp_status,
    taxMethod: row.tax_method,
    pph21SubjectType: row.pph21_subject_type,
    baseSalaryIdr: idr(BigInt(row.base_salary_idr)),
    fixedAllowancesIdr: idr(sumAllowances(row.fixed_allowances_json)),
    bpjsFlags: flagsOf(row.bpjs_flags_json),
    nik: openField(dek, tenantId, "nik", row.nik_enc),
    bankAccountNumber: openField(dek, tenantId, "bank_account_number", row.bank_account_number_enc),
    nitku: row.nitku_22,
    companyName: row.company_name,
    companyNpwp: row.npwp_16,
    umpUmkIdr: idr(BigInt(row.ump_umk_idr)),
    jkkRiskClass: row.jkk_risk_class,
  };
}

function openField(
  dek: Buffer | null,
  tenantId: string,
  field: "nik" | "bank_account_number",
  envelope: string | null,
): string {
  if (!dek || !envelope) return "";
  return decryptField(dek, tenantId, field, envelope);
}

function sumAllowances(value: unknown): bigint {
  const record = asObject(value);
  let total = 0n;
  for (const amount of Object.values(record)) {
    if (typeof amount === "string" && /^(?:0|[1-9]\d*)$/u.test(amount)) total += BigInt(amount);
  }
  return total;
}

function flagsOf(value: unknown): BpjsFlags {
  const record = asObject(value);
  return {
    kesehatan: record.kesehatan === true,
    jht: record.jht === true,
    jkk: record.jkk === true,
    jkm: record.jkm === true,
    jp: record.jp === true,
    jkp: record.jkp === true,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function monthEnd(year: number, month: number): string {
  const leap = month === 2 && (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0));
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const day = lengths[month - 1] ?? 30;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function queryRows<T>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  if (Array.isArray(result)) return result as T[];
  return [];
}

function rowCount(result: unknown): number {
  if (result && typeof result === "object" && "rowCount" in result) {
    const count = (result as { rowCount: number | null }).rowCount;
    return count ?? 0;
  }
  return 0;
}
