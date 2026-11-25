import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle shape of the platform control-plane tables.
 * `migrate.ts` is the DDL that is applied. Change both together.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
}

export const featureFlagKeys = ["aiAssistant", "coretaxXml", "sso"] as const;
export type FeatureFlagKey = (typeof featureFlagKeys)[number];
export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export interface PlanQuotas {
  maxSeats: number;
  maxBranches: number;
  maxStorageMb: number;
  monthlyAiTokens: number;
}

export const sysPlans = pgTable("sys_plans", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  defaultQuotasJson: jsonb("default_quotas_json").$type<PlanQuotas>().notNull(),
  defaultFeatureFlagsJson: jsonb("default_feature_flags_json").$type<FeatureFlags>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sysPlatformOperators = pgTable("sys_platform_operators", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  authUserId: text("auth_user_id").notNull().unique(),
  role: text("role").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sysTenantQuotas = pgTable(
  "sys_tenant_quotas",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull().unique(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => sysPlans.id),
    status: text("status").notNull().default("active"),
    customDomain: text("custom_domain"),
    subdomain: text("subdomain"),
    maxSeats: integer("max_seats").notNull(),
    maxBranches: integer("max_branches").notNull(),
    maxStorageMb: integer("max_storage_mb").notNull(),
    monthlyAiTokens: integer("monthly_ai_tokens").notNull(),
    featureFlagsJson: jsonb("feature_flags_json").$type<FeatureFlags>().notNull(),
    ownerInviteTokenHash: text("owner_invite_token_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("sys_tenant_quotas_subdomain_uidx").on(table.subdomain),
    uniqueIndex("sys_tenant_quotas_custom_domain_uidx").on(table.customDomain),
    check("sys_tenant_quotas_status_check", sql`${table.status} in ('active', 'suspended')`),
  ],
);

export const sysSupportGrants = pgTable("sys_support_grants", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  tenantId: uuid("tenant_id").notNull(),
  grantedByUserId: uuid("granted_by_user_id").notNull(),
  granteePlatformUserId: uuid("grantee_platform_user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scope: text("scope").notNull().default("read_only"),
  allowPiiReveal: boolean("allow_pii_reveal").notNull().default(false),
  reason: text("reason").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  sessionTokenHash: text("session_token_hash"),
  activatedAt: timestamp("activated_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sysPlatformAuditEvents = pgTable("sys_platform_audit_events", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  actorPlatformUserId: uuid("actor_platform_user_id").notNull(),
  action: text("action").notNull(),
  targetTenantId: uuid("target_tenant_id"),
  supportGrantId: uuid("support_grant_id"),
  diffJson: jsonb("diff_json").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  createdAt: createdAt(),
});
