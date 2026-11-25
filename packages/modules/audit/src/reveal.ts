import type { PiiField } from "@gotonghr/crypto";
import { decryptField } from "@gotonghr/crypto/decrypt";
import { isPiiField } from "@gotonghr/crypto";
import { supportPiiRevealDeny, supportPiiRevealSetting } from "@gotonghr/contracts";
import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { PiiRevealDeniedError, PiiRevealReasonError, SupportGrantPiiDeniedError } from "./errors.ts";
import { readTenantSecrets } from "./keys.ts";
import { assertUuid, queryRows } from "./sql.ts";
import { assertSameTenant } from "./tenant.ts";

export { PiiRevealDeniedError, PiiRevealReasonError, SupportGrantPiiDeniedError } from "./errors.ts";

declare const revealedBrand: unique symbol;
declare const ciphertextBrand: unique symbol;

/** Plaintext returned only by `revealPii`. List code keeps masked strings instead. */
export type RevealedPii = string & { readonly [revealedBrand]: true };

/** Marks a stored envelope at the reveal call site. A masked list value is not one of these. */
export type Ciphertext = string & { readonly [ciphertextBrand]: true };

export interface RevealCaller {
  tenantId: string;
  userId: string;
  permissions: readonly string[];
  ipAddress?: string;
  /**
   * Set when the caller is a support-grant session.
   * `false` refuses the reveal before any `aud_pii_access_logs` insert.
   * The session wrapper also sets `app.support_pii_reveal` to `deny`.
   */
  supportGrantAllowPiiReveal?: boolean;
}

export interface RevealRequest {
  field: PiiField;
  ciphertext: Ciphertext;
  resourceType: string;
  resourceId: string;
  reason: string;
}

const REVEAL_PERMISSION = "employee.pii.reveal";

export function asCiphertext(value: string): Ciphertext {
  const trimmed = value.trim();
  if (trimmed.length < 24) throw new Error("ciphertext is empty");
  return trimmed as Ciphertext;
}

/**
 * Decrypts one field after an explicit reveal.
 * The caller must already hold `employee.pii.reveal` and pass a non-empty reason.
 * The access log row is inserted in `tx` before the plaintext is returned.
 * List and detail handlers do not import this module.
 */
export async function revealPii(
  tx: TenantTx,
  caller: RevealCaller,
  request: RevealRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RevealedPii> {
  if (await supportGrantDeniesReveal(tx, caller.supportGrantAllowPiiReveal)) {
    throw new SupportGrantPiiDeniedError();
  }
  if (!caller.permissions.includes(REVEAL_PERMISSION)) {
    throw new PiiRevealDeniedError();
  }
  const reason = request.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new PiiRevealReasonError();
  }
  if (!isPiiField(request.field)) throw new Error("unknown pii field");
  const tenantId = await assertSameTenant(tx, caller.tenantId);
  const actorUserId = assertUuid(caller.userId, "actor user id");
  const resourceId = assertUuid(request.resourceId, "resource id");
  const resourceType = request.resourceType.trim();
  if (resourceType.length === 0 || resourceType.length > 80) {
    throw new Error("resource type is required.");
  }
  const ipAddress = caller.ipAddress?.trim() || null;
  if (ipAddress && ipAddress.length > 64) throw new Error("ip address is too long");

  const secrets = await readTenantSecrets(tx, tenantId, env);
  const plaintext = decryptField(secrets.dek, tenantId, request.field, request.ciphertext);
  const inserted = queryRows<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO aud_pii_access_logs (
        tenant_id, actor_user_id, field_name, resource_type, resource_id, reason, ip_address
      ) VALUES (
        ${tenantId}::uuid,
        ${actorUserId}::uuid,
        ${request.field},
        ${resourceType},
        ${resourceId}::uuid,
        ${reason},
        ${ipAddress}
      )
      RETURNING id::text AS id
    `),
  );
  if (!inserted[0]?.id) throw new Error("PII access log insert failed");
  return plaintext as RevealedPii;
}

/**
 * A live support grant with `allow_pii_reveal = false` sets the transaction GUC
 * to `deny`. The caller flag covers a session that passes the flag directly.
 * Either one refuses before decrypt and before the access log insert.
 */
async function supportGrantDeniesReveal(
  tx: TenantTx,
  supportGrantAllowPiiReveal: boolean | undefined,
): Promise<boolean> {
  if (supportGrantAllowPiiReveal === false) return true;
  const rows = queryRows<{ gate: string | null }>(
    await tx.execute(
      sql`SELECT current_setting(${supportPiiRevealSetting}, true) AS gate`,
    ),
  );
  return rows[0]?.gate === supportPiiRevealDeny;
}
