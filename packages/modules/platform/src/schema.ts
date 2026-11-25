import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  index,
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

export const sysPlatformOperators = pgTable(
  "sys_platform_operators",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    authUserId: text("auth_user_id").notNull().unique(),
    role: text("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "sys_platform_operators_role_check",
      sql`${table.role} in ('platform_super_admin', 'platform_ops')`,
    ),
  ],
);

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
    uniqueIndex("sys_tenant_quotas_subdomain_uidx")
      .on(table.subdomain)
      .where(sql`${table.subdomain} is not null`),
    uniqueIndex("sys_tenant_quotas_custom_domain_uidx")
      .on(table.customDomain)
      .where(sql`${table.customDomain} is not null`),
    check("sys_tenant_quotas_status_check", sql`${table.status} in ('active', 'suspended')`),
    check(
      "sys_tenant_quotas_positive",
      sql`${table.maxSeats} > 0 and ${table.maxBranches} > 0 and ${table.maxStorageMb} > 0 and ${table.monthlyAiTokens} >= 0`,
    ),
  ],
);

export const sysSupportGrants = pgTable(
  "sys_support_grants",
  {
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
  },
  (table) => [
    check("sys_support_grants_scope_check", sql`${table.scope} in ('read_only', 'read_write')`),
    check(
      "sys_support_grants_expiry_after_create",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '4 hours'`,
    ),
    check("sys_support_grants_reason_check", sql`length(trim(${table.reason})) > 0`),
    uniqueIndex("sys_support_grants_session_hash_uidx")
      .on(table.sessionTokenHash)
      .where(sql`${table.sessionTokenHash} is not null`),
    index("sys_support_grants_tenant_id_idx").on(table.tenantId),
  ],
);

export const statutoryStatuses = ["draft", "published", "archived"] as const;
export type StatutoryStatus = (typeof statutoryStatuses)[number];

/**
 * `pph21` is the payroll-engine document: TER, PTKP, Pasal 17, and the JP cap.
 * The other codes are the spec's single-rule names. Publish verifies `pph21` only.
 */
export const statutoryRuleTypes = [
  "pph21",
  "ter_a",
  "ter_b",
  "ter_c",
  "pasal17",
  "bpjs_caps",
  "ptkp",
] as const;
export type StatutoryRuleType = (typeof statutoryRuleTypes)[number];

/** Quotes a fixed identifier list for a SQL `IN` clause. Values are not user input. */
export function sqlStringList(values: readonly string[]): string {
  return values
    .map((value) => {
      if (!/^[a-z0-9_]+$/u.test(value)) throw new Error(`Unsafe SQL literal: ${value}`);
      return `'${value}'`;
    })
    .join(", ");
}

export const payStatutoryTables = pgTable(
  "pay_statutory_tables",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    ruleType: text("rule_type").notNull(),
    versionLabel: text("version_label").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    status: text("status").notNull().default("draft"),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    createdByOperatorId: uuid("created_by_operator_id")
      .notNull()
      .references(() => sysPlatformOperators.id),
    publishedByOperatorId: uuid("published_by_operator_id").references(
      () => sysPlatformOperators.id,
    ),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pay_statutory_tables_lookup_idx")
      .on(table.ruleType, table.effectiveFrom)
      .where(sql`${table.status} = 'published'`),
    check(
      "pay_statutory_tables_status_check",
      sql`${table.status} in (${sql.raw(sqlStringList(statutoryStatuses))})`,
    ),
    check(
      "pay_statutory_tables_rule_type_check",
      sql`${table.ruleType} in (${sql.raw(sqlStringList(statutoryRuleTypes))})`,
    ),
    check(
      "pay_statutory_tables_effective_order",
      sql`${table.effectiveTo} is null or ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "pay_statutory_tables_version_label_check",
      sql`length(trim(${table.versionLabel})) between 1 and 80`,
    ),
    check(
      "pay_statutory_tables_publish_meta_check",
      sql`(
        (${table.status} = 'published'
          and ${table.publishedAt} is not null
          and ${table.publishedByOperatorId} is not null)
        or (${table.status} in ('draft', 'archived')
          and ${table.publishedAt} is null
          and ${table.publishedByOperatorId} is null)
      )`,
    ),
  ],
);

export const sysPlatformAuditEvents = pgTable(
  "sys_platform_audit_events",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorPlatformUserId: uuid("actor_platform_user_id").notNull(),
    action: text("action").notNull(),
    targetTenantId: uuid("target_tenant_id"),
    supportGrantId: uuid("support_grant_id"),
    diffJson: jsonb("diff_json").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
  },
  (table) => [index("sys_platform_audit_events_created_at_idx").on(table.createdAt.desc())],
);
