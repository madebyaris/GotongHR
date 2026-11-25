const PLATFORM_ROLE = "platform_admin";

export const deploymentModes = [
  "single_tenant",
  "multi_tenant_saas",
  "holding_multi_tenant",
] as const;

export type DeploymentMode = (typeof deploymentModes)[number];

/**
 * The request pool is `DATABASE_URL_PLATFORM` only.
 * A missing value throws. It is never replaced with the migrator URL.
 */
export function readPlatformDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_URL_PLATFORM;
  if (!value) throw new Error("Missing DATABASE_URL_PLATFORM.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL_PLATFORM is not a valid URL.");
  }
  const username = decodeURIComponent(parsed.username);
  if (username !== PLATFORM_ROLE) {
    throw new Error("DATABASE_URL_PLATFORM must use the platform_admin role.");
  }
  return value;
}

/**
 * `single_tenant` does not mount platform or tenant support-grant routes.
 * Both multi-tenant modes do, matching the architecture spec and the web shell.
 */
export function platformApiMounted(mode: DeploymentMode): boolean {
  return mode === "multi_tenant_saas" || mode === "holding_multi_tenant";
}
