import type { TenantExportFile, TenantExportReadPort, TenantExportTable, TenantExportTableName } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { ObjectStorage } from "@gotonghr/storage";
import { sql } from "drizzle-orm";

const employeeColumns = [
  "id",
  "employee_code",
  "full_name",
  "legal_entity_id",
  "branch_id",
  "department_id",
  "position_id",
  "employment_status",
  "join_date",
  "ptkp_status",
  "tax_method",
  "pph21_subject_type",
  "user_id",
  "date_of_birth",
] as const;

const contractColumns = [
  "id",
  "employee_id",
  "contract_type",
  "status",
  "start_date",
  "end_date",
  "department_id",
  "position_id",
  "manager_employee_id",
  "compensation_paid",
] as const;

const attendanceColumns = [
  "id",
  "employee_id",
  "branch_id",
  "punch_type",
  "captured_at",
  "received_at",
  "sync_source",
  "lat",
  "lng",
  "geofence_ok",
  "review_status",
] as const;

const leaveColumns = [
  "id",
  "employee_id",
  "leave_type_id",
  "start_date",
  "end_date",
  "day_count",
  "status",
  "requested_by_user_id",
] as const;

const payrollColumns = [
  "id",
  "legal_entity_id",
  "period_year_month",
  "status",
  "total_gross_idr",
  "total_tax_idr",
  "total_net_idr",
  "finalized_at",
] as const;

/**
 * In-process reads for the tenant archive.
 * The platform package does not import core HR, attendance, or payroll.
 * Rows are loaded inside the tenant transaction. File bytes are opened after it ends.
 * Employee ciphertext is not selected.
 */
export function createTenantExportRead(input: {
  appDb: TenantDatabase;
  storage: ObjectStorage;
}): TenantExportReadPort {
  return {
    async tables(tenantId) {
      return input.appDb.withTenantContext(tenantId, async (tx) => {
        const employees = queryRows<Record<string, unknown>>(
          await tx.execute(sql`
            SELECT
              id::text AS id,
              employee_code,
              full_name,
              legal_entity_id::text AS legal_entity_id,
              branch_id::text AS branch_id,
              department_id::text AS department_id,
              position_id::text AS position_id,
              employment_status,
              join_date::text AS join_date,
              ptkp_status,
              tax_method,
              pph21_subject_type,
              user_id::text AS user_id,
              date_of_birth::text AS date_of_birth
            FROM hr_employees
            ORDER BY employee_code, id
          `),
        );
        const contracts = queryRows<Record<string, unknown>>(
          await tx.execute(sql`
            SELECT
              id::text AS id,
              employee_id::text AS employee_id,
              contract_type,
              status,
              start_date::text AS start_date,
              end_date::text AS end_date,
              department_id::text AS department_id,
              position_id::text AS position_id,
              manager_employee_id::text AS manager_employee_id,
              compensation_paid::text AS compensation_paid
            FROM hr_contracts
            ORDER BY start_date, id
          `),
        );
        const attendance = queryRows<Record<string, unknown>>(
          await tx.execute(sql`
            SELECT
              id::text AS id,
              employee_id::text AS employee_id,
              branch_id::text AS branch_id,
              punch_type,
              to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
              to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at,
              sync_source,
              lat::text AS lat,
              lng::text AS lng,
              geofence_ok::text AS geofence_ok,
              review_status
            FROM att_clock_events
            ORDER BY captured_at, id
          `),
        );
        const leave = queryRows<Record<string, unknown>>(
          await tx.execute(sql`
            SELECT
              id::text AS id,
              employee_id::text AS employee_id,
              leave_type_id::text AS leave_type_id,
              start_date::text AS start_date,
              end_date::text AS end_date,
              day_count::text AS day_count,
              status,
              requested_by_user_id::text AS requested_by_user_id
            FROM att_leave_requests
            ORDER BY start_date, id
          `),
        );
        const payrollRuns = queryRows<Record<string, unknown>>(
          await tx.execute(sql`
            SELECT
              id::text AS id,
              legal_entity_id::text AS legal_entity_id,
              period_year_month,
              status,
              total_gross_idr::text AS total_gross_idr,
              total_tax_idr::text AS total_tax_idr,
              total_net_idr::text AS total_net_idr,
              to_char(finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finalized_at
            FROM pay_runs
            ORDER BY period_year_month, id
          `),
        );
        return [
          toTable("employees", employeeColumns, employees),
          toTable("contracts", contractColumns, contracts),
          toTable("attendance", attendanceColumns, attendance),
          toTable("leave", leaveColumns, leave),
          toTable("payroll_runs", payrollColumns, payrollRuns),
        ];
      });
    },
    async files(tenantId) {
      const listed = await input.appDb.withTenantContext(tenantId, async (tx) => {
        const coretax = queryRows<{ id: string; storage_key: string }>(
          await tx.execute(sql`
            SELECT id::text AS id, storage_key
            FROM pay_exports
            WHERE export_kind = 'coretax'
            ORDER BY id
          `),
        );
        const payslips = queryRows<{ id: string; storage_key: string }>(
          await tx.execute(sql`
            SELECT id::text AS id, payslip_storage_key AS storage_key
            FROM pay_run_items
            WHERE payslip_storage_key IS NOT NULL
            ORDER BY id
          `),
        );
        return { coretax, payslips };
      });
      return [
        ...listed.coretax.map((row) => storedFile(input.storage, `coretax/${row.id}.xml`, row.storage_key)),
        ...listed.payslips.map((row) => storedFile(input.storage, `payslips/${row.id}.pdf`, row.storage_key)),
      ];
    },
  };
}

function toTable(
  name: TenantExportTableName,
  columns: readonly string[],
  records: Array<Record<string, unknown>>,
): TenantExportTable {
  return {
    name,
    columns,
    async *rows() {
      for (const record of records) {
        yield columns.map((column) => cell(record[column]));
      }
    },
  };
}

function storedFile(storage: ObjectStorage, zipPath: string, key: string): TenantExportFile {
  return {
    zipPath,
    open: () => storage.openRead({ key }),
  };
}

function cell(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error("Export value is not text.");
}

function queryRows<T>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  if (Array.isArray(result)) return result as T[];
  return [];
}
