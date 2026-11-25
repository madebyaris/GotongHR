import { sql } from "drizzle-orm";
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle shape of the employee tables. `migrate.ts` is the DDL that is applied.
 * Change both together. Ciphertext stays in `hr_employee_pii`. List queries read masks.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

export const hrEmployees = pgTable(
  "hr_employees",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeCode: text("employee_code").notNull(),
    fullName: text("full_name").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    departmentId: uuid("department_id"),
    positionId: uuid("position_id"),
    employmentStatus: text("employment_status").notNull(),
    joinDate: date("join_date", { mode: "string" }).notNull(),
    ptkpStatus: text("ptkp_status").notNull(),
    taxMethod: text("tax_method").notNull(),
    pph21SubjectType: text("pph21_subject_type").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_employees_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("hr_employees_code_key").on(table.tenantId, table.employeeCode),
    index("hr_employees_tenant_branch_idx").on(table.tenantId, table.branchId),
  ],
);

export const hrEmployeePii = pgTable(
  "hr_employee_pii",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    nikEnc: text("nik_enc").notNull(),
    npwpEnc: text("npwp_enc"),
    kkNumberEnc: text("kk_number_enc"),
    bpjsKesehatanNoEnc: text("bpjs_kesehatan_no_enc"),
    bpjsTkNoEnc: text("bpjs_tk_no_enc"),
    bankAccountNumberEnc: text("bank_account_number_enc"),
    nikHash: text("nik_hash").notNull(),
    npwpHash: text("npwp_hash"),
    nikMask: text("nik_mask").notNull(),
    npwpMask: text("npwp_mask"),
    kkNumberMask: text("kk_number_mask"),
    bpjsKesehatanNoMask: text("bpjs_kesehatan_no_mask"),
    bpjsTkNoMask: text("bpjs_tk_no_mask"),
    bankAccountNumberMask: text("bank_account_number_mask"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_employee_pii_employee_key").on(table.tenantId, table.employeeId),
    uniqueIndex("hr_employee_pii_nik_hash_key").on(table.tenantId, table.nikHash),
    index("hr_employee_pii_npwp_hash_idx").on(table.tenantId, table.npwpHash),
  ],
);
