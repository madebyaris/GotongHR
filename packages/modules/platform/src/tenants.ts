import { roleCodes, rolePermissions, roleScopeDefaults } from "@gotonghr/contracts";
import type pg from "pg";
import { PlatformError } from "./errors.ts";
import type { PlatformDatabase } from "./db.ts";
import { featureFlagKeys, type FeatureFlagKey, type FeatureFlags } from "./schema.ts";

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  passwordHash: string;
  planCode: string;
  inviteTokenHash: string;
}

export interface ProvisionedTenant {
  tenantId: string;
  organizationId: string;
  authUserId: string;
  ownerUserId: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  planCode: string;
  subdomain: string | null;
  customDomain: string | null;
  maxSeats: number;
  maxBranches: number;
  maxStorageMb: number;
  monthlyAiTokens: number;
  featureFlags: FeatureFlags;
}

export interface TenantConfigPatch {
  planCode?: string;
  subdomain?: string | null;
  customDomain?: string | null;
  maxSeats?: number;
  maxBranches?: number;
  maxStorageMb?: number;
  monthlyAiTokens?: number;
  featureFlags?: Partial<Record<FeatureFlagKey, boolean>>;
}

export async function provisionTenant(
  platform: PlatformDatabase,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  try {
    const result = await platform.pool.query<{
      tenant_id: string;
      organization_id: string;
      auth_user_id: string;
      owner_user_id: string;
    }>(
      `SELECT tenant_id, organization_id, auth_user_id, owner_user_id
       FROM sys_provision_tenant($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        input.name,
        input.slug,
        input.ownerEmail,
        input.ownerName,
        input.passwordHash,
        input.planCode,
        JSON.stringify(roleSeed()),
        input.inviteTokenHash,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new PlatformError(500, "internal_error", "Tenant was not created.");
    return {
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      authUserId: row.auth_user_id,
      ownerUserId: row.owner_user_id,
    };
  } catch (error) {
    throw mapped(error);
  }
}

export async function storeInviteHash(
  platform: PlatformDatabase,
  tenantId: string,
  inviteTokenHash: string,
): Promise<void> {
  const result = await platform.pool.query(
    `UPDATE sys_tenant_quotas
     SET owner_invite_token_hash = $2, updated_at = now()
     WHERE tenant_id = $1`,
    [tenantId, inviteTokenHash],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new PlatformError(404, "not_found", "Tenant was not found.");
  }
}

export async function setTenantStatus(
  platform: PlatformDatabase,
  tenantId: string,
  status: "active" | "suspended",
): Promise<void> {
  try {
    await platform.pool.query("SELECT sys_set_tenant_status($1::uuid, $2)", [tenantId, status]);
  } catch (error) {
    throw mapped(error);
  }
}

export async function listTenants(platform: PlatformDatabase): Promise<TenantSummary[]> {
  const result = await platform.pool.query<TenantRow>(
    `${tenantSelect}
     ORDER BY t.created_at
     LIMIT 200`,
  );
  return result.rows.map(toSummary);
}

export async function updateTenantConfig(
  platform: PlatformDatabase,
  tenantId: string,
  patch: TenantConfigPatch,
): Promise<TenantSummary> {
  const current = await platform.pool.query<TenantRow>(`${tenantSelect} WHERE t.id = $1`, [
    tenantId,
  ]);
  const row = current.rows[0];
  if (!row) throw new PlatformError(404, "not_found", "Tenant was not found.");
  const flags = mergeFlags(parseFlags(row.feature_flags_json), patch.featureFlags);
  let planId = row.plan_id;
  if (patch.planCode && patch.planCode !== row.plan_code) {
    const plan = await platform.pool.query<{ id: string }>(
      "SELECT id FROM sys_plans WHERE code = $1",
      [patch.planCode],
    );
    const next = plan.rows[0];
    if (!next) throw new PlatformError(400, "unknown_plan", "Plan was not found.");
    planId = next.id;
  }
  try {
    await platform.pool.query(
      `UPDATE sys_tenant_quotas
       SET plan_id = $2,
           subdomain = $3,
           custom_domain = $4,
           max_seats = $5,
           max_branches = $6,
           max_storage_mb = $7,
           monthly_ai_tokens = $8,
           feature_flags_json = $9::jsonb,
           updated_at = now()
       WHERE tenant_id = $1`,
      [
        tenantId,
        planId,
        patch.subdomain === undefined ? row.subdomain : patch.subdomain,
        patch.customDomain === undefined ? row.custom_domain : patch.customDomain,
        patch.maxSeats ?? row.max_seats,
        patch.maxBranches ?? row.max_branches,
        patch.maxStorageMb ?? row.max_storage_mb,
        patch.monthlyAiTokens ?? row.monthly_ai_tokens,
        JSON.stringify(flags),
      ],
    );
  } catch (error) {
    throw mapped(error);
  }
  const updated = await platform.pool.query<TenantRow>(`${tenantSelect} WHERE t.id = $1`, [
    tenantId,
  ]);
  const summary = updated.rows[0];
  if (!summary) throw new PlatformError(404, "not_found", "Tenant was not found.");
  return toSummary(summary);
}

export async function registerPlatformOperator(
  platform: PlatformDatabase,
  input: { authUserId: string; role: "platform_super_admin" | "platform_ops" },
): Promise<{ id: string }> {
  const result = await platform.pool.query<{ id: string }>(
    `INSERT INTO sys_platform_operators (auth_user_id, role)
     VALUES ($1, $2)
     ON CONFLICT (auth_user_id) DO UPDATE
       SET role = EXCLUDED.role, updated_at = now()
     RETURNING id`,
    [input.authUserId, input.role],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new PlatformError(500, "internal_error", "Operator was not stored.");
  return { id };
}

export interface HealthTenant {
  tenantId: string;
  status: "active" | "suspended";
  activeUsers: null;
  peakClockIns: null;
  queueDepth: null;
  webhookFailureRate: null;
  storageBytes: null;
}

export async function listTenantHealth(platform: PlatformDatabase): Promise<HealthTenant[]> {
  const tenants = await listTenants(platform);
  return tenants.map((tenant) => ({
    tenantId: tenant.id,
    status: tenant.status,
    activeUsers: null,
    peakClockIns: null,
    queueDepth: null,
    webhookFailureRate: null,
    storageBytes: null,
  }));
}

export async function writeAudit(
  queryable: Pick<pg.Pool, "query"> | pg.PoolClient,
  event: {
    actorId: string;
    action: string;
    tenantId: string | null;
    grantId: string | null;
    diff: Record<string, unknown> | null;
    ip: string | null;
  },
): Promise<void> {
  await queryable.query(
    `INSERT INTO sys_platform_audit_events
      (actor_platform_user_id, action, target_tenant_id, support_grant_id, diff_json, ip_address)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb, $6)`,
    [
      event.actorId,
      event.action,
      event.tenantId,
      event.grantId,
      event.diff ? JSON.stringify(event.diff) : null,
      event.ip,
    ],
  );
}

export interface AuditEvent {
  id: string;
  actorPlatformUserId: string;
  action: string;
  targetTenantId: string | null;
  supportGrantId: string | null;
  diff: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export async function listAuditEvents(platform: PlatformDatabase): Promise<AuditEvent[]> {
  const result = await platform.pool.query<{
    id: string;
    actor_platform_user_id: string;
    action: string;
    target_tenant_id: string | null;
    support_grant_id: string | null;
    diff_json: Record<string, unknown> | null;
    ip_address: string | null;
    created_at: Date;
  }>(
    `SELECT id, actor_platform_user_id, action, target_tenant_id, support_grant_id,
            diff_json, ip_address, created_at
     FROM sys_platform_audit_events
     ORDER BY created_at DESC
     LIMIT 100`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    actorPlatformUserId: row.actor_platform_user_id,
    action: row.action,
    targetTenantId: row.target_tenant_id,
    supportGrantId: row.support_grant_id,
    diff: row.diff_json,
    ipAddress: row.ip_address,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  }));
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan_id: string;
  plan_code: string;
  subdomain: string | null;
  custom_domain: string | null;
  max_seats: number;
  max_branches: number;
  max_storage_mb: number;
  monthly_ai_tokens: number;
  feature_flags_json: unknown;
}

const tenantSelect = `
  SELECT t.id, t.name, t.slug, t.status,
         q.plan_id, p.code AS plan_code, q.subdomain, q.custom_domain,
         q.max_seats, q.max_branches, q.max_storage_mb, q.monthly_ai_tokens,
         q.feature_flags_json
  FROM id_tenants t
  JOIN sys_tenant_quotas q ON q.tenant_id = t.id
  JOIN sys_plans p ON p.id = q.plan_id
`;

function toSummary(row: TenantRow): TenantSummary {
  if (row.status !== "active" && row.status !== "suspended") {
    throw new PlatformError(500, "internal_error", "Tenant status is invalid.");
  }
  const flags = parseFlags(row.feature_flags_json);
  if (!flags) throw new PlatformError(500, "internal_error", "Feature flags are invalid.");
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    planCode: row.plan_code,
    subdomain: row.subdomain,
    customDomain: row.custom_domain,
    maxSeats: row.max_seats,
    maxBranches: row.max_branches,
    maxStorageMb: row.max_storage_mb,
    monthlyAiTokens: row.monthly_ai_tokens,
    featureFlags: flags,
  };
}

function parseFlags(value: unknown): FeatureFlags | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const flags = {} as FeatureFlags;
  for (const key of featureFlagKeys) {
    const item = record[key];
    if (typeof item !== "boolean") return null;
    flags[key] = item;
  }
  return flags;
}

function mergeFlags(
  current: FeatureFlags | null,
  patch: Partial<Record<FeatureFlagKey, boolean>> | undefined,
): FeatureFlags {
  if (!current) throw new PlatformError(500, "internal_error", "Feature flags are invalid.");
  if (!patch) return current;
  const next: FeatureFlags = { ...current };
  for (const key of featureFlagKeys) {
    const value = patch[key];
    if (typeof value === "boolean") next[key] = value;
  }
  return next;
}

function roleSeed(): unknown[] {
  return roleCodes.map((code) => ({
    code,
    permissions: [...rolePermissions[code]],
    directReportsOnly: roleScopeDefaults[code].directReportsOnly,
    selfOnly: roleScopeDefaults[code].selfOnly,
  }));
}

function mapped(error: unknown): Error {
  if (error instanceof PlatformError) return error;
  const next = platformErrorFromDatabase(error);
  return next ?? (error instanceof Error ? error : new Error("Request failed."));
}

export function platformErrorFromDatabase(error: unknown): PlatformError | null {
  if (!error || typeof error !== "object") return null;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "23505") return new PlatformError(409, "conflict", "That value is already in use.");
  if (code === "23503") return new PlatformError(400, "invalid_reference", "The reference was not found.");
  if (code === "P0002" || message.includes("tenant not found")) {
    return new PlatformError(404, "not_found", "Tenant was not found.");
  }
  if (message.includes("plan is unknown")) {
    return new PlatformError(400, "unknown_plan", "Plan was not found.");
  }
  if (code === "23514") return new PlatformError(400, "invalid", "The value was rejected.");
  return null;
}
