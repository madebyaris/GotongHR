import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle shape of the AI tables. `migrate.ts` is the DDL that is applied.
 * Change both together.
 * `confirmation_nonce` stores the SHA-256 hex of the secret, not the secret.
 * `search_vector` is a generated tsvector. Keyword search does not use pgvector.
 */

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    title: text("title"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("ai_conversations_tenant_idx").on(table.tenantId, table.createdAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role").notNull(),
    contentRedacted: text("content_redacted").notNull(),
    toolCallsJson: jsonb("tool_calls_json"),
    createdAt: createdAt(),
  },
  (table) => [
    index("ai_messages_conversation_idx").on(table.conversationId, table.createdAt),
    index("ai_messages_tenant_idx").on(table.tenantId),
  ],
);

export const aiActionProposals = pgTable(
  "ai_action_proposals",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    conversationId: uuid("conversation_id"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    toolName: text("tool_name").notNull(),
    argumentsJson: jsonb("arguments_json").notNull(),
    impactPreviewJson: jsonb("impact_preview_json").notNull(),
    confirmationNonce: text("confirmation_nonce").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "date" }),
    decidedByUserId: uuid("decided_by_user_id"),
    executionResultJson: jsonb("execution_result_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("ai_action_proposals_tenant_status_idx").on(table.tenantId, table.status, table.expiresAt),
    index("ai_action_proposals_creator_idx").on(table.tenantId, table.createdByUserId),
  ],
);

export const aiKnowledgeChunks = pgTable(
  "ai_knowledge_chunks",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id"),
    sourceType: text("source_type").notNull(),
    citationRef: text("citation_ref").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    isStatuteText: boolean("is_statute_text").notNull(),
    documentId: uuid("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(citation_ref, ''))`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("ai_knowledge_chunks_tenant_idx").on(table.tenantId),
    index("ai_knowledge_chunks_search_idx").using("gin", table.searchVector),
  ],
);
