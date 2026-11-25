import type {
  EmployeeRecord,
  EmploymentStatus,
  Pph21SubjectType,
  PtkpStatus,
  TaxMethod,
} from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { scopeClause, assertReadable } from "./access.ts";
import type { CoreHrAuth } from "./auth.ts";
import { queryRows } from "./sql.ts";

/**
 * List and detail read stored masks. Ciphertext stays in the vault table.
 * Reveal is a separate route.
 */

const columns = sql`
  e.id::text AS id,
  e.employee_code,
  e.full_name,
  e.legal_entity_id::text AS legal_entity_id,
  e.branch_id::text AS branch_id,
  e.department_id::text AS department_id,
  e.position_id::text AS position_id,
  e.employment_status,
  e.join_date::text AS join_date,
  e.ptkp_status,
  e.tax_method,
  e.pph21_subject_type,
  p.nik_mask,
  p.npwp_mask,
  p.kk_number_mask,
  p.bpjs_kesehatan_no_mask,
  p.bpjs_tk_no_mask,
  p.bank_account_number_mask
`;

interface EmployeeRow {
  id: string;
  employee_code: string;
  full_name: string;
  legal_entity_id: string;
  branch_id: string;
  department_id: string | null;
  position_id: string | null;
  employment_status: string;
  join_date: string;
  ptkp_status: string;
  tax_method: string;
  pph21_subject_type: string;
  nik_mask: string;
  npwp_mask: string | null;
  kk_number_mask: string | null;
  bpjs_kesehatan_no_mask: string | null;
  bpjs_tk_no_mask: string | null;
  bank_account_number_mask: string | null;
}

export async function listEmployees(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  page: { limit: number; offset: number },
): Promise<EmployeeRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => listEmployeesTx(tx, auth, page));
}

export async function getEmployee(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  id: string,
): Promise<EmployeeRecord | null> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => findEmployeeTx(tx, auth, id));
}

export async function listEmployeesTx(
  tx: TenantTx,
  auth: CoreHrAuth,
  page: { limit: number; offset: number },
): Promise<EmployeeRecord[]> {
  const result = await tx.execute(sql`
    SELECT ${columns}
    FROM hr_employees AS e
    JOIN hr_employee_pii AS p ON p.employee_id = e.id AND p.tenant_id = e.tenant_id
    WHERE true
    ${scopeClause(auth)}
    ORDER BY e.created_at, e.id
    LIMIT ${page.limit} OFFSET ${page.offset}
  `);
  return queryRows<EmployeeRow>(result).map(toRecord);
}

export async function findEmployeeTx(
  tx: TenantTx,
  auth: CoreHrAuth,
  id: string,
): Promise<EmployeeRecord | null> {
  const result = await tx.execute(sql`
    SELECT ${columns}
    FROM hr_employees AS e
    JOIN hr_employee_pii AS p ON p.employee_id = e.id AND p.tenant_id = e.tenant_id
    WHERE e.id = ${id}::uuid
    ${scopeClause(auth)}
  `);
  const row = queryRows<EmployeeRow>(result)[0];
  return row ? toRecord(row) : null;
}

function toRecord(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
    departmentId: row.department_id,
    positionId: row.position_id,
    employmentStatus: asStatus(row.employment_status),
    joinDate: row.join_date,
    ptkpStatus: asPtkp(row.ptkp_status),
    taxMethod: asTax(row.tax_method),
    pph21SubjectType: asSubject(row.pph21_subject_type),
    nikMask: row.nik_mask,
    npwpMask: row.npwp_mask,
    kkNumberMask: row.kk_number_mask,
    bpjsKesehatanNoMask: row.bpjs_kesehatan_no_mask,
    bpjsTkNoMask: row.bpjs_tk_no_mask,
    bankAccountNumberMask: row.bank_account_number_mask,
  };
}

function asStatus(value: string): EmploymentStatus {
  if (value === "active" || value === "probation" || value === "resigned" || value === "terminated") {
    return value;
  }
  throw new Error("employment status is not valid");
}

function asPtkp(value: string): PtkpStatus {
  if (
    value === "TK/0" ||
    value === "TK/1" ||
    value === "TK/2" ||
    value === "TK/3" ||
    value === "K/0" ||
    value === "K/1" ||
    value === "K/2" ||
    value === "K/3"
  ) {
    return value;
  }
  throw new Error("ptkp status is not valid");
}

function asTax(value: string): TaxMethod {
  if (value === "gross" || value === "nett" || value === "gross_up") return value;
  throw new Error("tax method is not valid");
}

function asSubject(value: string): Pph21SubjectType {
  if (value === "permanent" || value === "non_permanent" || value === "expat") return value;
  throw new Error("pph21 subject is not valid");
}
