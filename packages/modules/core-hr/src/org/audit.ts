import { appendAuditEvent, provisionTenantKeys } from "@gotonghr/audit";
import type { TenantTx } from "@gotonghr/db";
import type { CoreHrAuth } from "../auth.ts";
import { asObject, clip } from "../sql.ts";

export async function writeAudit(
  tx: TenantTx,
  auth: CoreHrAuth,
  action: string,
  resourceType: string,
  resourceId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await provisionTenantKeys(tx, auth.tenantId);
  await appendAuditEvent(
    tx,
    {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorRole: auth.role,
      action,
      resourceType,
      resourceId,
      diff: { before: asObject(before), after: asObject(after) },
      aiProposalId: null,
      supportGrantId: null,
      ipAddress: clip(auth.ipAddress, 64),
      userAgent: clip(auth.userAgent, 512),
    },
    { requireTenantKeys: true },
  );
}
