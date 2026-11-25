export { openPlatformDatabase } from "./db.ts";
export type { PlatformDatabase } from "./db.ts";
export { platformApiMounted, readPlatformDatabaseUrl } from "./env.ts";
export { PlatformError } from "./errors.ts";
export {
  activateSupportGrant,
  createSupportGrant,
  revokeSupportGrant,
  withSupportSession,
} from "./grants.ts";
export type { ActivatedGrant, CreatedGrant, GrantScope } from "./grants.ts";
export { migratePlatform } from "./migrate.ts";
export type { PlatformMigrateInput } from "./migrate.ts";
export { registerPlatform } from "./routes.ts";
export type {
  PlatformActor,
  PlatformActorResult,
  PlatformDeps,
  TenantAdmin,
  TenantAdminResult,
} from "./routes.ts";
export { featureFlagKeys } from "./schema.ts";
export type { FeatureFlags } from "./schema.ts";
export {
  listAuditEvents,
  listTenants,
  provisionTenant,
  registerPlatformOperator,
  setTenantStatus,
  updateTenantConfig,
} from "./tenants.ts";
export { expiryError, hashToken, signInvite, verifyInvite } from "./tokens.ts";
