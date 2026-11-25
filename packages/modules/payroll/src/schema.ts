import { sql } from "drizzle-orm";
import { bigint, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle shape of the payroll tables. `migrate.ts` is the DDL that is applied.
 * Money columns are integer rupiah. JSON snapshots are frozen by the trigger.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

export const payRuns = pgTable(
  "pay_runs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    periodYearMonth: text("period_year_month").notNull(),
    status: text("status").notNull().default("draft"),
    statutoryTableVersionId: uuid("statutory_table_version_id"),
    totalGrossIdr: bigint("total_gross_idr", { mode: "bigint" }).notNull().default(sql`0`),
    totalTaxIdr: bigint("total_tax_idr", { mode: "bigint" }).notNull().default(sql`0`),
    totalNetIdr: bigint("total_net_idr", { mode: "bigint" }).notNull().default(sql`0`),
    pdfBatchEnqueuedCount: integer("pdf_batch_enqueued_count").notNull().default(0),
    calcBatchTotal: integer("calc_batch_total").notNull().default(0),
    calcCompletedBatches: integer("calc_completed_batches").array().notNull().default(sql`'{}'::integer[]`),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    finalizedBy: uuid("finalized_by"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("pay_runs_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("pay_runs_entity_period_key").on(table.tenantId, table.legalEntityId, table.periodYearMonth),
  ],
);

export const payRunItems = pgTable(
  "pay_run_items",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    ownerUserId: uuid("owner_user_id"),
    employeeSnapshotJson: jsonb("employee_snapshot_json").notNull(),
    attendanceSnapshotJson: jsonb("attendance_snapshot_json").notNull(),
    earningsJson: jsonb("earnings_json").notNull(),
    deductionsJson: jsonb("deductions_json").notNull(),
    bpjsJson: jsonb("bpjs_json").notNull(),
    pph21Json: jsonb("pph21_json").notNull(),
    grossIdr: bigint("gross_idr", { mode: "bigint" }).notNull(),
    taxIdr: bigint("tax_idr", { mode: "bigint" }).notNull(),
    netIdr: bigint("net_idr", { mode: "bigint" }).notNull(),
    payslipStorageKey: text("payslip_storage_key"),
    payslipGeneratedAt: timestamp("payslip_generated_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("pay_run_items_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("pay_run_items_run_employee_key").on(table.tenantId, table.runId, table.employeeId),
  ],
);

export const payExports = pgTable(
  "pay_exports",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    exportKind: text("export_kind").notNull(),
    slipType: text("slip_type"),
    bankId: text("bank_id"),
    storageKey: text("storage_key").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "bigint" }).notNull(),
    metadataJson: jsonb("metadata_json").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("pay_exports_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("pay_exports_storage_key_key").on(table.tenantId, table.storageKey),
  ],
);
