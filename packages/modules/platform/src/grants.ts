import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import type { PlatformDatabase } from "./db.ts";
import { PlatformError } from "./errors.ts";
import { hashToken, randomToken } from "./tokens.ts";
import { platformErrorFromDatabase, writeAudit } from "./tenants.ts";

export type GrantScope = "read_only" | "read_write";

export interface CreatedGrant {
  id: string;
  token: string;
  scope: GrantScope;
  allowPiiReveal: boolean;
  expiresAt: string;
}

export interface ActivatedGrant {
  grantId: string;
  tenantId: string;
  contextTenantId: string;
  scope: GrantScope;
  allowPiiReveal: boolean;
  expiresAt: string;
  sessionToken: string;
}

export async function createSupportGrant(
  app: TenantDatabase,
  input: {
    tenantId: string;
    grantedByUserId: string;
    granteePlatformUserId: string;
    reason: string;
    expiresAt: Date;
    scope: GrantScope;
    allowPiiReveal: boolean;
  },
): Promise<CreatedGrant> {
  const token = randomToken();
  const tokenHash = hashToken(token);
  try {
    const created = await app.withTenantContext(input.tenantId, async (tx) => {
      const operator = await tx.execute<{ id: string }>(sql`
        SELECT id FROM sys_platform_operators WHERE id = ${input.granteePlatformUserId}::uuid
      `);
      if (!operator.rows[0]) {
        throw new PlatformError(400, "unknown_operator", "Platform operator was not found.");
      }
      const window = await tx.execute<{ ok: boolean }>(sql`
        SELECT ${input.expiresAt.toISOString()}::timestamptz > now()
           AND ${input.expiresAt.toISOString()}::timestamptz <= now() + interval '4 hours' AS ok
      `);
      if (window.rows[0]?.ok !== true) {
        throw new PlatformError(400, "grant_expiry", "Grant expiry must be within the next four hours.");
      }
      const inserted = await tx.execute<{
        id: string;
        scope: string;
        allow_pii_reveal: boolean;
        expires_at: Date;
      }>(sql`
        INSERT INTO sys_support_grants (
          tenant_id, granted_by_user_id, grantee_platform_user_id, token_hash,
          scope, allow_pii_reveal, reason, expires_at
        ) VALUES (
          ${input.tenantId}::uuid,
          ${input.grantedByUserId}::uuid,
          ${input.granteePlatformUserId}::uuid,
          ${tokenHash},
          ${input.scope},
          ${input.allowPiiReveal},
          ${input.reason},
          ${input.expiresAt.toISOString()}::timestamptz
        )
        RETURNING id, scope, allow_pii_reveal, expires_at
      `);
      const row = inserted.rows[0];
      if (!row) throw new PlatformError(500, "internal_error", "Grant was not stored.");
      return row;
    });
    if (created.scope !== "read_only" && created.scope !== "read_write") {
      throw new PlatformError(500, "internal_error", "Grant scope is invalid.");
    }
    return {
      id: created.id,
      token,
      scope: created.scope,
      allowPiiReveal: created.allow_pii_reveal,
      expiresAt: asIso(created.expires_at),
    };
  } catch (error) {
    throw mapped(error);
  }
}

export async function revokeSupportGrant(
  app: TenantDatabase,
  input: { tenantId: string; grantId: string },
): Promise<{ id: string; revokedAt: string }> {
  try {
    return await app.withTenantContext(input.tenantId, async (tx) => {
      const updated = await tx.execute<{ id: string; revoked_at: Date }>(sql`
        UPDATE sys_support_grants
        SET revoked_at = now(), updated_at = now()
        WHERE id = ${input.grantId}::uuid AND revoked_at IS NULL
        RETURNING id, revoked_at
      `);
      const row = updated.rows[0];
      if (row) return { id: row.id, revokedAt: asIso(row.revoked_at) };
      const existing = await tx.execute<{ id: string; revoked_at: Date | null }>(sql`
        SELECT id, revoked_at FROM sys_support_grants WHERE id = ${input.grantId}::uuid
      `);
      const found = existing.rows[0];
      if (!found?.revoked_at) throw new PlatformError(404, "not_found", "Support grant was not found.");
      return { id: found.id, revokedAt: asIso(found.revoked_at) };
    });
  } catch (error) {
    throw mapped(error);
  }
}

export async function activateSupportGrant(
  platform: PlatformDatabase,
  app: TenantDatabase,
  input: { token: string; actorId: string; ip: string | null },
): Promise<ActivatedGrant> {
  const sessionToken = randomToken();
  const consumed = await consumeGrant(platform, {
    tokenHash: hashToken(input.token),
    sessionHash: hashToken(sessionToken),
    actorId: input.actorId,
    ip: input.ip,
  });
  const contextTenantId = await app.withTenantContext(consumed.tenantId, (tx) => currentTenantId(tx));
  if (contextTenantId !== consumed.tenantId) {
    throw new PlatformError(500, "internal_error", "Tenant context did not match the grant.");
  }
  return {
    grantId: consumed.id,
    tenantId: consumed.tenantId,
    contextTenantId,
    scope: consumed.scope,
    allowPiiReveal: consumed.allowPiiReveal,
    expiresAt: consumed.expiresAt,
    sessionToken,
  };
}

export async function withSupportSession<T>(
  platform: PlatformDatabase,
  app: TenantDatabase,
  input: { sessionToken: string; actorId: string; ip: string | null },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<{ tenantId: string; contextTenantId: string; result: T }> {
  const sessionHash = hashToken(input.sessionToken);
  const found = await platform.pool.query<GrantState>(
    `SELECT id, tenant_id, grantee_platform_user_id, scope, allow_pii_reveal, expires_at,
            revoked_at IS NOT NULL AS revoked,
            expires_at <= now() AS expired
     FROM sys_support_grants
     WHERE session_token_hash = $1`,
    [sessionHash],
  );
  const row = found.rows[0];
  if (!row) throw new PlatformError(403, "grant_invalid", "Support session was rejected.");
  if (row.grantee_platform_user_id !== input.actorId) {
    throw new PlatformError(403, "grant_forbidden", "Support session was rejected.");
  }
  if (row.revoked) throw new PlatformError(403, "grant_revoked", "Support grant was revoked.");
  if (row.expired) throw new PlatformError(403, "grant_expired", "Support grant has expired.");
  const scope = readScope(row.scope);
  const result = await app.withTenantContext(row.tenant_id, async (tx) => {
    const contextTenantId = await currentTenantId(tx);
    if (contextTenantId !== row.tenant_id) {
      throw new PlatformError(500, "internal_error", "Tenant context did not match the grant.");
    }
    const value = await fn(tx);
    return { contextTenantId, value };
  });
  await writeAudit(platform.pool, {
    actorId: input.actorId,
    action: "support_grant.session",
    tenantId: row.tenant_id,
    grantId: row.id,
    diff: { scope, allowPiiReveal: row.allow_pii_reveal },
    ip: input.ip,
  });
  return { tenantId: row.tenant_id, contextTenantId: result.contextTenantId, result: result.value };
}

async function consumeGrant(
  platform: PlatformDatabase,
  input: { tokenHash: string; sessionHash: string; actorId: string; ip: string | null },
): Promise<{
  id: string;
  tenantId: string;
  scope: GrantScope;
  allowPiiReveal: boolean;
  expiresAt: string;
}> {
  const client = await platform.pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<GrantState>(
      `SELECT id, tenant_id, grantee_platform_user_id, scope, allow_pii_reveal, expires_at,
              revoked_at IS NOT NULL AS revoked,
              consumed_at IS NOT NULL AS consumed,
              expires_at <= now() AS expired
       FROM sys_support_grants
       WHERE token_hash = $1
       FOR UPDATE`,
      [input.tokenHash],
    );
    const row = found.rows[0];
    if (!row) throw new PlatformError(403, "grant_invalid", "Support grant was rejected.");
    if (row.grantee_platform_user_id !== input.actorId) {
      throw new PlatformError(403, "grant_forbidden", "Support grant was rejected.");
    }
    if (row.revoked) throw new PlatformError(403, "grant_revoked", "Support grant was revoked.");
    if (row.consumed) throw new PlatformError(403, "grant_consumed", "Support grant was already used.");
    if (row.expired) throw new PlatformError(403, "grant_expired", "Support grant has expired.");
    const updated = await client.query(
      `UPDATE sys_support_grants
       SET consumed_at = now(), activated_at = now(), session_token_hash = $2, updated_at = now()
       WHERE id = $1
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()`,
      [row.id, input.sessionHash],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new PlatformError(403, "grant_consumed", "Support grant was already used.");
    }
    await writeAudit(client, {
      actorId: input.actorId,
      action: "support_grant.activate",
      tenantId: row.tenant_id,
      grantId: row.id,
      diff: { scope: row.scope, allowPiiReveal: row.allow_pii_reveal },
      ip: input.ip,
    });
    await client.query("COMMIT");
    return {
      id: row.id,
      tenantId: row.tenant_id,
      scope: readScope(row.scope),
      allowPiiReveal: row.allow_pii_reveal,
      expiresAt: asIso(row.expires_at),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapped(error);
  } finally {
    client.release();
  }
}

interface GrantState {
  id: string;
  tenant_id: string;
  grantee_platform_user_id: string;
  scope: string;
  allow_pii_reveal: boolean;
  expires_at: Date | string;
  revoked?: boolean;
  consumed?: boolean;
  expired?: boolean;
}

async function currentTenantId(tx: TenantTx): Promise<string> {
  const result = await tx.execute<{ tenant_id: string | null }>(sql`
    SELECT current_setting('app.current_tenant_id', true) AS tenant_id
  `);
  const tenantId = result.rows[0]?.tenant_id;
  if (!tenantId) throw new PlatformError(500, "internal_error", "Tenant context was not set.");
  return tenantId;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function readScope(value: string): GrantScope {
  if (value === "read_only" || value === "read_write") return value;
  throw new PlatformError(500, "internal_error", "Grant scope is invalid.");
}

function mapped(error: unknown): Error {
  if (error instanceof PlatformError) return error;
  const next = platformErrorFromDatabase(error);
  return next ?? (error instanceof Error ? error : new Error("Request failed."));
}
