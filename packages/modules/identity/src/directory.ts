import {
  isPermissionAtom,
  roleCodes,
  rolePermissions,
  roleScopeDefaults,
  type PermissionAtom,
  type RoleCode,
} from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import { sql, type SQL } from "drizzle-orm";
import pg from "pg";
import type { DeploymentMode } from "./env.ts";
import { SingleTenantOccupiedError } from "./errors.ts";

export interface MembershipRecord {
  tenantId: string;
  organizationId: string;
  authUserId: string;
  userId: string;
  email: string;
  role: string;
  permissions: PermissionAtom[];
  scopeEntityIds: string[];
  scopeBranchIds: string[];
  directReportsOnly: boolean;
  selfOnly: boolean;
}

interface MembershipSqlRow {
  tenant_id: string;
  organization_id: string;
  auth_user_id: string;
  user_id: string;
  email: string;
  role_code: string;
  permissions: string[] | null;
  scope_entity_ids: string[] | null;
  scope_branch_ids: string[] | null;
  direct_reports_only: boolean;
  self_only: boolean;
}

export interface TenantOwnerRow {
  tenantId: string;
  organizationId: string;
  email: string;
  authUserId: string;
}

export async function tenantCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: number }>("SELECT id_tenant_count() AS count");
  return Number(result.rows[0]?.count ?? 0);
}

export async function tenantIdForOrganization(
  pool: pg.Pool,
  organizationId: string,
): Promise<string | null> {
  const result = await pool.query<{ id: string | null }>(
    "SELECT id_tenant_id_for_organization($1) AS id",
    [organizationId],
  );
  return result.rows[0]?.id ?? null;
}

export async function singleTenantOwner(pool: pg.Pool): Promise<TenantOwnerRow | null> {
  const result = await pool.query<{
    tenant_id: string;
    organization_id: string;
    owner_email: string;
    owner_auth_user_id: string;
  }>("SELECT * FROM id_single_tenant_owner()");
  const row = result.rows[0];
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    email: row.owner_email,
    authUserId: row.owner_auth_user_id,
  };
}

export interface TenantAccess {
  tenantId: string;
  status: "active" | "suspended";
}

/**
 * Every membership, including a suspended tenant. Sign-in and the request
 * guard use this. `membershipsForAuthUser` stays limited to active rows.
 */
export async function tenantAccessForAuthUser(
  pool: pg.Pool,
  authUserId: string,
): Promise<TenantAccess[]> {
  const result = await pool.query<{ tenant_id: string; status: string }>(
    "SELECT tenant_id, status FROM id_tenant_access_for_auth_user($1)",
    [authUserId],
  );
  return result.rows.flatMap((row) => {
    if (row.status !== "active" && row.status !== "suspended") return [];
    return [{ tenantId: row.tenant_id, status: row.status }];
  });
}

/** True when the user has a membership and every one of those tenants is suspended. */
export async function userIsSuspended(pool: pg.Pool, authUserId: string): Promise<boolean> {
  const access = await tenantAccessForAuthUser(pool, authUserId);
  return access.length > 0 && access.every((row) => row.status === "suspended");
}

/** Pass the session user id. This function can see every active tenant that user belongs to. */
export async function membershipsForAuthUser(
  pool: pg.Pool,
  authUserId: string,
): Promise<MembershipRecord[]> {
  const result = await pool.query<MembershipSqlRow>(
    "SELECT * FROM id_memberships_for_auth_user($1)",
    [authUserId],
  );
  return result.rows.map((row) => ({
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    authUserId: row.auth_user_id,
    userId: row.user_id,
    email: row.email,
    role: row.role_code,
    permissions: (row.permissions ?? []).filter(isPermissionAtom),
    scopeEntityIds: row.scope_entity_ids ?? [],
    scopeBranchIds: row.scope_branch_ids ?? [],
    directReportsOnly: row.direct_reports_only,
    selfOnly: row.self_only,
  }));
}

export async function assertCanCreateOrganization(
  pool: pg.Pool,
  mode: DeploymentMode,
): Promise<void> {
  if (mode !== "single_tenant") return;
  const count = await tenantCount(pool);
  if (count >= 1) throw new SingleTenantOccupiedError();
}

export async function provisionDirectory(
  appDb: TenantDatabase,
  input: {
    organizationId: string;
    name: string;
    slug: string;
    authUserId: string;
    email: string;
    displayName: string;
  },
): Promise<string> {
  try {
    const idResult = await appDb.pool.query<{ id: string }>("SELECT uuidv7() AS id");
    const tenantId = idResult.rows[0]?.id;
    if (!tenantId) throw new Error("uuidv7() returned no id.");
    await appDb.withTenantContext(tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO id_tenants (id, organization_id, name, slug, status)
        VALUES (${tenantId}::uuid, ${input.organizationId}, ${input.name}, ${input.slug}, 'active')
      `);
      for (const code of roleCodes) {
        await tx.execute(sql`
          INSERT INTO id_roles (tenant_id, code, permissions)
          VALUES (${tenantId}::uuid, ${code}, ${textArray(rolePermissions[code])})
        `);
      }
      await insertUserMembership(tx, {
        tenantId,
        authUserId: input.authUserId,
        email: input.email,
        displayName: input.displayName,
        role: "org_owner",
      });
    });
    return tenantId;
  } catch (error) {
    await appDb.pool
      .query("DELETE FROM ba_organization WHERE id = $1", [input.organizationId])
      .catch(() => undefined);
    throw error;
  }
}

export async function insertMembership(
  appDb: TenantDatabase,
  input: {
    tenantId: string;
    authUserId: string;
    email: string;
    displayName: string;
    role: RoleCode;
  },
): Promise<string> {
  return appDb.withTenantContext(input.tenantId, (tx) => insertUserMembership(tx, input));
}

async function insertUserMembership(
  tx: Parameters<Parameters<TenantDatabase["withTenantContext"]>[1]>[0],
  input: {
    tenantId: string;
    authUserId: string;
    email: string;
    displayName: string;
    role: RoleCode;
  },
): Promise<string> {
  const scope = roleScopeDefaults[input.role];
  const inserted = await tx.execute(sql`
    INSERT INTO id_users (tenant_id, auth_user_id, email, display_name)
    VALUES (${input.tenantId}::uuid, ${input.authUserId}, ${input.email}, ${input.displayName})
    RETURNING id
  `);
  const userId = readId(inserted.rows[0]);
  if (!userId) throw new Error("id_users insert returned no id.");
  const membership = await tx.execute(sql`
    INSERT INTO id_memberships (
      tenant_id, user_id, auth_user_id, role_id, direct_reports_only, self_only
    )
    SELECT ${input.tenantId}::uuid, ${userId}::uuid, ${input.authUserId}, id_roles.id,
      ${scope.directReportsOnly}, ${scope.selfOnly}
    FROM id_roles
    WHERE id_roles.tenant_id = ${input.tenantId}::uuid AND id_roles.code = ${input.role}
    RETURNING id
  `);
  if ((membership.rowCount ?? 0) < 1) {
    throw new Error(`Role ${input.role} is not seeded for this tenant.`);
  }
  return userId;
}

export async function recordSession(
  appDb: TenantDatabase,
  session: { id?: string; userId?: string },
  options?: { totpVerified?: boolean },
): Promise<void> {
  const sessionId = session.id;
  const authUserId = session.userId;
  if (!sessionId || !authUserId) return;
  const totpVerified = options?.totpVerified === true;
  const memberships = await membershipsForAuthUser(appDb.pool, authUserId);
  for (const membership of memberships) {
    await appDb.withTenantContext(membership.tenantId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO id_sessions (
          tenant_id, auth_session_id, auth_user_id, user_id, totp_verified_at
        )
        VALUES (
          ${membership.tenantId}::uuid,
          ${sessionId},
          ${authUserId},
          ${membership.userId}::uuid,
          ${totpVerified ? sql`now()` : sql`NULL`}
        )
        ON CONFLICT (tenant_id, auth_session_id) DO UPDATE
        SET totp_verified_at = COALESCE(id_sessions.totp_verified_at, EXCLUDED.totp_verified_at)
      `);
    });
  }
  if (totpVerified) await revokeOtherAuthSessions(appDb, authUserId, sessionId);
}

export async function markSessionTotpVerified(
  appDb: TenantDatabase,
  authUserId: string,
  authSessionId: string,
): Promise<void> {
  const memberships = await membershipsForAuthUser(appDb.pool, authUserId);
  for (const membership of memberships) {
    await appDb.withTenantContext(membership.tenantId, async (tx) => {
      await tx.execute(sql`
        UPDATE id_sessions
        SET totp_verified_at = COALESCE(totp_verified_at, now())
        WHERE auth_session_id = ${authSessionId}
      `);
    });
  }
}

export async function sessionHasTotpVerification(
  appDb: TenantDatabase,
  tenantId: string,
  authSessionId: string,
): Promise<boolean> {
  return appDb.withTenantContext(tenantId, async (tx) => {
    const result = await tx.execute<{ verified: boolean }>(sql`
      SELECT totp_verified_at IS NOT NULL AS verified
      FROM id_sessions
      WHERE auth_session_id = ${authSessionId}
    `);
    return result.rows[0]?.verified === true;
  });
}

async function revokeOtherAuthSessions(
  appDb: TenantDatabase,
  authUserId: string,
  keepSessionId: string,
): Promise<void> {
  const memberships = await membershipsForAuthUser(appDb.pool, authUserId);
  for (const membership of memberships) {
    await appDb.withTenantContext(membership.tenantId, async (tx) => {
      await tx.execute(sql`
        DELETE FROM id_sessions
        WHERE auth_user_id = ${authUserId}
          AND auth_session_id <> ${keepSessionId}
      `);
    });
  }
  await appDb.pool.query("DELETE FROM ba_session WHERE user_id = $1 AND id <> $2", [
    authUserId,
    keepSessionId,
  ]);
}

function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function readId(row: unknown): string | null {
  if (!row || typeof row !== "object" || !("id" in row)) return null;
  const id = row.id;
  return typeof id === "string" ? id : null;
}
