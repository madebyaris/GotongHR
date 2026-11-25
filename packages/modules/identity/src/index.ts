export { createAuth } from "./auth.ts";
export type { CreateAuthInput, GotongAuth } from "./auth.ts";
export { bootstrapOwner, ensureCredentialUser, grantMembership, tenantSlug } from "./bootstrap.ts";
export type { BootstrapResult, CredentialUserInput } from "./bootstrap.ts";
export { sessionCookieAttributes } from "./cookies.ts";
export { membershipsForAuthUser, tenantCount } from "./directory.ts";
export type { MembershipRecord } from "./directory.ts";
export {
  normalizeEmail,
  readAuthBaseUrl,
  readAuthRateLimit,
  readAuthSecret,
  readBootstrapInput,
  readDeploymentMode,
  readTrustCloudflare,
  readTrustProxy,
  readTrustedOrigins,
} from "./env.ts";
export type { BootstrapInput, DeploymentMode } from "./env.ts";
export {
  isPrivateProxyAddress,
  isTrustedProxyPeer,
  trustProxyFunction,
} from "./proxy-address.ts";
export type { TrustProxySetting } from "./proxy-address.ts";
export { SingleTenantOccupiedError } from "./errors.ts";
export { requirePermission, TENANT_HEADER } from "./guard.ts";
export type { GotongAuthContext } from "./guard.ts";
export { migrateIdentity } from "./migrate.ts";
export type { IdentityMigrateInput } from "./migrate.ts";
export { argon2Parameters, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password.ts";
export { registerIdentity } from "./plugin.ts";
export type { IdentityHandle, RegisterIdentityOptions } from "./plugin.ts";
