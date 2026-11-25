import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { PROPOSAL_TTL_MINUTES } from "./nonce.ts";

export interface MessageRow {
  role: string;
  content_redacted: string;
  tool_calls_json: unknown;
}

export interface ProposalRow {
  id: string;
  conversation_id: string | null;
  created_by_user_id: string;
  tool_name: string;
  arguments_json: unknown;
  impact_preview_json: unknown;
  confirmation_nonce: string;
  status: string;
  expires_at: Date | string;
  executed_at: Date | string | null;
  decided_by_user_id: string | null;
  execution_result_json: unknown;
  created_at: Date | string;
}

export async function insertConversation(
  tx: TenantTx,
  input: { tenantId: string; userId: string; title: string },
): Promise<string> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO ai_conversations (tenant_id, created_by_user_id, title)
      VALUES (${input.tenantId}::uuid, ${input.userId}::uuid, ${input.title})
      RETURNING id::text AS id
    `),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("conversation insert returned no id");
  return id;
}

export async function conversationOwnedBy(
  tx: TenantTx,
  input: { conversationId: string; userId: string },
): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT id::text AS id
      FROM ai_conversations
      WHERE id = ${input.conversationId}::uuid
        AND created_by_user_id = ${input.userId}::uuid
    `),
  );
  return rows.length === 1;
}

export async function touchConversation(tx: TenantTx, conversationId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE ai_conversations
    SET updated_at = now()
    WHERE id = ${conversationId}::uuid
  `);
}

export async function insertMessage(
  tx: TenantTx,
  input: {
    tenantId: string;
    conversationId: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls: unknown | null;
  },
): Promise<void> {
  const toolCalls =
    input.toolCalls === null ? sql`NULL` : sql`${JSON.stringify(input.toolCalls)}::jsonb`;
  await tx.execute(sql`
    INSERT INTO ai_messages (tenant_id, conversation_id, role, content_redacted, tool_calls_json)
    VALUES (
      ${input.tenantId}::uuid,
      ${input.conversationId}::uuid,
      ${input.role},
      ${input.content},
      ${toolCalls}
    )
  `);
}

export async function listMessages(tx: TenantTx, conversationId: string): Promise<MessageRow[]> {
  return rowsOf<MessageRow>(
    await tx.execute(sql`
      SELECT role, content_redacted, tool_calls_json
      FROM ai_messages
      WHERE conversation_id = ${conversationId}::uuid
      ORDER BY created_at, id
    `),
  );
}

export async function insertProposal(
  tx: TenantTx,
  input: {
    tenantId: string;
    conversationId: string;
    userId: string;
    toolName: string;
    argumentsJson: Record<string, unknown>;
    impactJson: Record<string, unknown>;
    nonceHash: string;
  },
): Promise<{ id: string; expiresAt: string }> {
  const rows = rowsOf<{ id: string; expires_at: Date | string }>(
    await tx.execute(sql`
      INSERT INTO ai_action_proposals (
        tenant_id, conversation_id, created_by_user_id, tool_name,
        arguments_json, impact_preview_json, confirmation_nonce, status, expires_at
      ) VALUES (
        ${input.tenantId}::uuid,
        ${input.conversationId}::uuid,
        ${input.userId}::uuid,
        ${input.toolName},
        ${JSON.stringify(input.argumentsJson)}::jsonb,
        ${JSON.stringify(input.impactJson)}::jsonb,
        ${input.nonceHash},
        'pending',
        now() + make_interval(mins => ${PROPOSAL_TTL_MINUTES})
      )
      RETURNING id::text AS id, expires_at
    `),
  );
  const row = rows[0];
  if (!row?.id) throw new Error("proposal insert returned no id");
  return { id: row.id, expiresAt: iso(row.expires_at) };
}

export async function lockProposal(tx: TenantTx, proposalId: string): Promise<ProposalRow | null> {
  const rows = rowsOf<ProposalRow>(
    await tx.execute(sql`
      SELECT
        id::text AS id,
        conversation_id::text AS conversation_id,
        created_by_user_id::text AS created_by_user_id,
        tool_name,
        arguments_json,
        impact_preview_json,
        confirmation_nonce,
        status,
        expires_at,
        executed_at,
        decided_by_user_id::text AS decided_by_user_id,
        execution_result_json,
        created_at
      FROM ai_action_proposals
      WHERE id = ${proposalId}::uuid
      FOR UPDATE
    `),
  );
  return rows[0] ?? null;
}

export async function markExpired(tx: TenantTx, proposalId: string): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      UPDATE ai_action_proposals
      SET status = 'expired', updated_at = now()
      WHERE id = ${proposalId}::uuid
        AND status = 'pending'
        AND expires_at <= now()
      RETURNING id::text AS id
    `),
  );
  return rows.length === 1;
}

export async function claimProposal(
  tx: TenantTx,
  input: { proposalId: string; userId: string },
): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      UPDATE ai_action_proposals
      SET status = 'executed',
          decided_by_user_id = ${input.userId}::uuid,
          executed_at = now(),
          updated_at = now()
      WHERE id = ${input.proposalId}::uuid
        AND status = 'pending'
        AND expires_at > now()
        AND created_by_user_id = ${input.userId}::uuid
      RETURNING id::text AS id
    `),
  );
  return rows.length === 1;
}

export async function saveExecution(
  tx: TenantTx,
  input: { proposalId: string; result: Record<string, unknown> },
): Promise<void> {
  await tx.execute(sql`
    UPDATE ai_action_proposals
    SET execution_result_json = ${JSON.stringify(input.result)}::jsonb,
        updated_at = now()
    WHERE id = ${input.proposalId}::uuid
      AND status = 'executed'
  `);
}

export async function rejectPending(
  tx: TenantTx,
  input: { proposalId: string; userId: string },
): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      UPDATE ai_action_proposals
      SET status = 'rejected',
          decided_by_user_id = ${input.userId}::uuid,
          updated_at = now()
      WHERE id = ${input.proposalId}::uuid
        AND status = 'pending'
        AND created_by_user_id = ${input.userId}::uuid
      RETURNING id::text AS id
    `),
  );
  return rows.length === 1;
}

export async function listOwnProposals(tx: TenantTx, userId: string): Promise<ProposalRow[]> {
  return rowsOf<ProposalRow>(
    await tx.execute(sql`
      SELECT
        id::text AS id,
        conversation_id::text AS conversation_id,
        created_by_user_id::text AS created_by_user_id,
        tool_name,
        arguments_json,
        impact_preview_json,
        '' AS confirmation_nonce,
        status,
        expires_at,
        executed_at,
        decided_by_user_id::text AS decided_by_user_id,
        execution_result_json,
        created_at
      FROM ai_action_proposals
      WHERE created_by_user_id = ${userId}::uuid
      ORDER BY created_at DESC, id DESC
    `),
  );
}

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

export function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function asJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const encoded = JSON.parse(
    JSON.stringify(parsed, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  ) as unknown;
  if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) return {};
  return encoded as Record<string, unknown>;
}
