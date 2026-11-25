import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle shape of `hr_import_jobs`. `imports/ddl.ts` is the DDL that is applied.
 * A job points at a CSV object. It does not store the file bytes.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

export const hrImportJobs = pgTable(
  "hr_import_jobs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    status: text("status").notNull(),
    mode: text("mode").notNull(),
    storageKey: text("storage_key").notNull(),
    legalEntityId: uuid("legal_entity_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    errorRows: integer("error_rows").notNull().default(0),
    writtenRows: integer("written_rows").notNull().default(0),
    lineErrors: jsonb("line_errors").notNull().default(sql`'[]'::jsonb`),
    errorJson: jsonb("error_json"),
    requestedBy: uuid("requested_by").notNull(),
    actorRole: text("actor_role").notNull().default("hr_admin"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_import_jobs_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("hr_import_jobs_storage_key_key").on(table.tenantId, table.storageKey),
    index("hr_import_jobs_status_idx").on(table.tenantId, table.status),
  ],
);
