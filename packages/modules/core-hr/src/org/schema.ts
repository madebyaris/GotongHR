import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle shape of the org tables. `migrate.ts` is the DDL that is applied.
 * Change both together. Compensation pay columns are append-only.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

export const hrDepartments = pgTable(
  "hr_departments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    branchId: uuid("branch_id"),
    parentDepartmentId: uuid("parent_department_id"),
    name: text("name").notNull(),
    code: text("code").notNull(),
    costCenterCode: text("cost_center_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_departments_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("hr_departments_code_key").on(table.tenantId, table.code),
    index("hr_departments_parent_idx").on(table.tenantId, table.parentDepartmentId),
  ],
);

export const hrPositions = pgTable(
  "hr_positions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id").notNull(),
    title: text("title").notNull(),
    code: text("code").notNull(),
    levelCode: text("level_code"),
    reportsToPositionId: uuid("reports_to_position_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_positions_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("hr_positions_code_key").on(table.tenantId, table.code),
    index("hr_positions_department_idx").on(table.tenantId, table.departmentId),
  ],
);

export const hrContracts = pgTable(
  "hr_contracts",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    contractType: text("contract_type").notNull(),
    status: text("status").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    departmentId: uuid("department_id"),
    positionId: uuid("position_id"),
    managerEmployeeId: uuid("manager_employee_id"),
    compensationPaid: boolean("compensation_paid").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_contracts_id_tenant_uidx").on(table.id, table.tenantId),
    index("hr_contracts_employee_idx").on(table.tenantId, table.employeeId),
    index("hr_contracts_active_end_idx")
      .on(table.endDate)
      .where(sql`status = 'active' AND end_date IS NOT NULL`),
  ],
);

export const hrCompensationProfiles = pgTable(
  "hr_compensation_profiles",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    baseSalaryIdr: bigint("base_salary_idr", { mode: "bigint" }).notNull(),
    fixedAllowancesJson: jsonb("fixed_allowances_json").notNull(),
    bpjsFlagsJson: jsonb("bpjs_flags_json").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    supersededBy: uuid("superseded_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_compensation_profiles_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("hr_compensation_profiles_start_key").on(
      table.tenantId,
      table.employeeId,
      table.effectiveFrom,
    ),
    uniqueIndex("hr_compensation_profiles_open_uidx")
      .on(table.tenantId, table.employeeId)
      .where(sql`effective_to IS NULL`),
    index("hr_compensation_profiles_employee_idx").on(table.tenantId, table.employeeId, table.effectiveFrom),
  ],
);

export const hrContractExpiryNotices = pgTable(
  "hr_contract_expiry_notices",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    contractId: uuid("contract_id").notNull(),
    windowDays: smallint("window_days").notNull(),
    noticeOn: date("notice_on", { mode: "string" }).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("hr_contract_expiry_notices_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("hr_contract_expiry_notices_dedupe_key").on(table.tenantId, table.dedupeKey),
  ],
);
