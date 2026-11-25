import { createHash } from "node:crypto";

export const GENESIS_LABEL = "gotonghr.audit.genesis.v1";

/** Formats a timestamptz so a hash written before insert matches the row read back. */
export const AUDIT_TIMESTAMP_FORMAT = "YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"";

export function hashChainEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.AUDIT_HASH_CHAIN;
  if (value === undefined || value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error("AUDIT_HASH_CHAIN must be on or off.");
}

export function genesisHash(tenantId: string): string {
  return createHash("sha256").update(`${GENESIS_LABEL}\n${tenantId}`, "utf8").digest("hex");
}

export interface ChainFields {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  diff: unknown;
  aiProposalId: string | null;
  supportGrantId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  prevHash: string;
  chainSeq: number;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new Error("audit hash cannot include bigint");
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("audit hash cannot include this value");
}

export function eventHash(fields: ChainFields): string {
  const payload = {
    action: fields.action,
    actor_role: fields.actorRole,
    actor_user_id: fields.actorUserId,
    ai_proposal_id: fields.aiProposalId,
    chain_seq: fields.chainSeq,
    created_at: fields.createdAt,
    diff: fields.diff,
    id: fields.id,
    ip_address: fields.ipAddress,
    prev_hash: fields.prevHash,
    resource_id: fields.resourceId,
    resource_type: fields.resourceType,
    support_grant_id: fields.supportGrantId,
    tenant_id: fields.tenantId,
    user_agent: fields.userAgent,
  };
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export interface StoredAuditEvent {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  diff: unknown;
  aiProposalId: string | null;
  supportGrantId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  prevHash: string | null;
  eventHash: string | null;
  chainSeq: number | null;
}

export type ChainVerification =
  | { ok: true; chained: boolean; events: number }
  | { ok: false; eventId: string };

/** Checks prev_hash links and recomputes event_hash. Order is the caller's order. */
export function verifyChain(tenantId: string, events: readonly StoredAuditEvent[]): ChainVerification {
  if (events.length === 0) return { ok: true, chained: false, events: 0 };
  const hashed = events.filter((event) => event.eventHash !== null);
  if (hashed.length !== 0 && hashed.length !== events.length) {
    const broken = events.find((event) => event.eventHash === null);
    return { ok: false, eventId: broken?.id ?? events[0]?.id ?? "" };
  }
  if (hashed.length === 0) return { ok: true, chained: false, events: events.length };

  let previous = genesisHash(tenantId);
  for (const event of events) {
    if (event.prevHash !== previous || event.eventHash === null || event.chainSeq === null) {
      return { ok: false, eventId: event.id };
    }
    const expected = eventHash({
      id: event.id,
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      actorRole: event.actorRole,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      diff: event.diff,
      aiProposalId: event.aiProposalId,
      supportGrantId: event.supportGrantId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      createdAt: event.createdAt,
      prevHash: previous,
      chainSeq: event.chainSeq,
    });
    if (event.eventHash !== expected) return { ok: false, eventId: event.id };
    previous = event.eventHash;
  }
  return { ok: true, chained: true, events: events.length };
}
