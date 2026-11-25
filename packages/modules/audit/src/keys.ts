import {
  generateKey,
  loadKek,
  unwrapDek,
  unwrapPepper,
  wrapDek,
  wrapPepper,
} from "@gotonghr/crypto";
import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { hashChainEnabledFromEnv } from "./hash-chain.ts";
import { queryRows } from "./sql.ts";
import { assertSameTenant } from "./tenant.ts";

export interface TenantSecrets {
  dek: Buffer;
  pepper: Buffer;
  hashChainEnabled: boolean;
}

/**
 * Creates the tenant DEK and blind-index pepper when the row is missing.
 * A second call does not rotate the keys. `AUDIT_HASH_CHAIN` defaults to on.
 */
export async function provisionTenantKeys(
  tx: TenantTx,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ created: boolean }> {
  const tenant = await assertSameTenant(tx, tenantId);
  const kek = loadKek(env);
  const wrappedDek = wrapDek(kek, generateKey(), tenant);
  const wrappedPepper = wrapPepper(kek, generateKey(), tenant);
  const hashChainEnabled = hashChainEnabledFromEnv(env);
  const inserted = queryRows<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO aud_tenant_keys (tenant_id, wrapped_dek, wrapped_pepper, hash_chain_enabled)
      VALUES (${tenant}::uuid, ${wrappedDek}, ${wrappedPepper}, ${hashChainEnabled})
      ON CONFLICT (tenant_id) DO NOTHING
      RETURNING id::text AS id
    `),
  );
  return { created: inserted.length > 0 };
}

export async function readTenantSecrets(
  tx: TenantTx,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TenantSecrets> {
  const tenant = await assertSameTenant(tx, tenantId);
  const rows = queryRows<{
    wrapped_dek: string;
    wrapped_pepper: string;
    hash_chain_enabled: boolean;
  }>(
    await tx.execute(sql`
      SELECT wrapped_dek, wrapped_pepper, hash_chain_enabled
      FROM aud_tenant_keys
      WHERE tenant_id = ${tenant}::uuid
    `),
  );
  const row = rows[0];
  if (!row) throw new Error("Tenant keys are not provisioned.");
  const kek = loadKek(env);
  return {
    dek: unwrapDek(kek, row.wrapped_dek, tenant),
    pepper: unwrapPepper(kek, row.wrapped_pepper, tenant),
    hashChainEnabled: asBoolean(row.hash_chain_enabled),
  };
}

export async function hashChainEnabledForTenant(
  tx: TenantTx,
  tenantId: string,
): Promise<boolean> {
  const rows = queryRows<{ hash_chain_enabled: boolean }>(
    await tx.execute(sql`
      SELECT hash_chain_enabled
      FROM aud_tenant_keys
      WHERE tenant_id = ${tenantId}::uuid
    `),
  );
  const row = rows[0];
  if (!row) throw new Error("Tenant keys are not provisioned.");
  return asBoolean(row.hash_chain_enabled);
}

function asBoolean(value: unknown): boolean {
  if (value === true || value === "t" || value === "true" || value === "on") return true;
  if (value === false || value === "f" || value === "false" || value === "off") return false;
  throw new Error("hash_chain_enabled was not a boolean");
}
