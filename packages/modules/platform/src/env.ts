const PLATFORM_ROLE = "platform_admin";

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
 * `single_tenant` does not mount `/api/v1/platform/*`.
 * Both multi-tenant modes do, matching the architecture spec and the web shell.
 */
export function platformApiMounted(mode: string): boolean {
  return mode === "multi_tenant_saas" || mode === "holding_multi_tenant";
}
