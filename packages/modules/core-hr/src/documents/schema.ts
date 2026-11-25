import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle shape of `hr_documents`. `documents/ddl.ts` is the DDL that is applied.
 * The table stores the storage key and metadata. It does not store file bytes.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

export const hrDocuments = pgTable(
  "hr_documents",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    docType: text("doc_type").notNull(),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("hr_documents_id_tenant_uidx").on(table.id, table.tenantId),
    uniqueIndex("hr_documents_storage_key_key").on(table.tenantId, table.storageKey),
    index("hr_documents_employee_idx").on(table.tenantId, table.employeeId),
  ],
);
