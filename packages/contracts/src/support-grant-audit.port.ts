/**
 * Tenant copy of a support-grant action.
 * `@gotonghr/audit` implements this. `apps/api` injects it into `@gotonghr/platform`.
 * Platform does not import the audit module.
 */
export interface SupportGrantTenantEvent {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  actorRole: string | null;
  supportGrantId: string | null;
  ipAddress: string | null;
  diff: Record<string, unknown>;
}

export interface SupportGrantAuditPort {
  appendEvent(event: SupportGrantTenantEvent): Promise<void>;
}

/** Transaction-local GUC. `deny` blocks `revealPii` before any access-log insert. */
export const supportPiiRevealSetting = "app.support_pii_reveal";

export const supportPiiRevealDeny = "deny";
