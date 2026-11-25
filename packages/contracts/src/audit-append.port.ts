/**
 * Append-only audit write. The AI module calls this inside the same
 * tenant transaction as the proposal change. `apps/api` binds it to
 * `@gotonghr/audit`. Modules do not import each other.
 */
export interface AuditEventDraft {
  tenantId: string;
  actorUserId: string;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  diff: Record<string, unknown>;
  aiProposalId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuditAppendPort {
  append(tx: unknown, event: AuditEventDraft): Promise<void>;
}
