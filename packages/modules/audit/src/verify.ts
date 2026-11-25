import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { AUDIT_TIMESTAMP_FORMAT, verifyChain, type ChainVerification, type StoredAuditEvent } from "./hash-chain.ts";
import { queryRows } from "./sql.ts";
import { assertSameTenant } from "./tenant.ts";

interface EventRow {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  diff_redacted_json: unknown;
  ai_proposal_id: string | null;
  support_grant_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  prev_hash: string | null;
  event_hash: string | null;
  chain_seq: number | string | null;
  created_at: string;
}

export async function verifyTenantHashChain(
  tx: TenantTx,
  tenantId: string,
): Promise<ChainVerification> {
  const tenant = await assertSameTenant(tx, tenantId);
  const rows = queryRows<EventRow>(
    await tx.execute(sql`
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        actor_user_id::text AS actor_user_id,
        actor_role,
        action,
        resource_type,
        resource_id::text AS resource_id,
        diff_redacted_json,
        ai_proposal_id::text AS ai_proposal_id,
        support_grant_id::text AS support_grant_id,
        ip_address,
        user_agent,
        prev_hash,
        event_hash,
        chain_seq,
        to_char(aud_events.created_at AT TIME ZONE 'UTC', ${AUDIT_TIMESTAMP_FORMAT}) AS created_at
      FROM aud_events
      WHERE aud_events.tenant_id = ${tenant}::uuid
      ORDER BY aud_events.chain_seq ASC NULLS LAST, aud_events.created_at ASC, aud_events.id ASC
    `),
  );
  const events: StoredAuditEvent[] = rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    diff: row.diff_redacted_json,
    aiProposalId: row.ai_proposal_id,
    supportGrantId: row.support_grant_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    prevHash: row.prev_hash,
    eventHash: row.event_hash,
    chainSeq: row.chain_seq === null ? null : Number(row.chain_seq),
  }));
  return verifyChain(tenant, events);
}
