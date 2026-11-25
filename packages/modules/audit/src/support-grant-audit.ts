import type { SupportGrantAuditPort, SupportGrantTenantEvent } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import { appendAuditEvent } from "./mutation.ts";

/** Builds the port `apps/api` injects into platform. Platform does not import this module. */
export function createSupportGrantAuditPort(app: TenantDatabase): SupportGrantAuditPort {
  return {
    async appendEvent(event: SupportGrantTenantEvent): Promise<void> {
      await app.withTenantContext(event.tenantId, async (tx) => {
        await appendAuditEvent(tx, {
          tenantId: event.tenantId,
          actorUserId: event.actorUserId,
          actorRole: event.actorRole,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          diff: event.diff,
          aiProposalId: null,
          supportGrantId: event.supportGrantId,
          ipAddress: event.ipAddress,
          userAgent: null,
        });
      });
    },
  };
}
