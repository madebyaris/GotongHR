import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle shape of the audit tables. `migrate.ts` is the DDL that is applied.
 * Change both together.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .default(sql`now()`);
}

export const audEvents = pgTable(
  "aud_events",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    diffRedactedJson: jsonb("diff_redacted_json").notNull(),
    aiProposalId: uuid("ai_proposal_id"),
    supportGrantId: uuid("support_grant_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    prevHash: text("prev_hash"),
    eventHash: text("event_hash"),
    chainSeq: bigint("chain_seq", { mode: "number" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("aud_events_tenant_created_idx").on(table.tenantId, table.createdAt, table.id),
    uniqueIndex("aud_events_tenant_chain_seq_uidx")
      .on(table.tenantId, table.chainSeq)
      .where(sql`chain_seq IS NOT NULL`),
  ],
);

export const audPiiAccessLogs = pgTable(
  "aud_pii_access_logs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    fieldName: text("field_name").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    reason: text("reason").notNull(),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
  },
  (table) => [index("aud_pii_access_logs_tenant_created_idx").on(table.tenantId, table.createdAt)],
);

export const audOutboxEvents = pgTable(
  "aud_outbox_events",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (table) => [
    index("aud_outbox_events_pending_idx")
      .on(table.createdAt, table.id)
      .where(sql`published_at IS NULL`),
  ],
);

export const audTenantKeys = pgTable("aud_tenant_keys", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  tenantId: uuid("tenant_id").notNull().unique(),
  wrappedDek: text("wrapped_dek").notNull(),
  wrappedPepper: text("wrapped_pepper").notNull(),
  hashChainEnabled: boolean("hash_chain_enabled").notNull().default(true),
  createdAt: createdAt(),
});
