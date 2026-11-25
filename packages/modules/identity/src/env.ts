import { MIN_PASSWORD_LENGTH } from "./password.ts";

const deploymentModes = ["single_tenant", "multi_tenant_saas", "holding_multi_tenant"] as const;

export type DeploymentMode = (typeof deploymentModes)[number];

const DEV_AUTH_SECRET = "gotonghr-dev-auth-secret-0123456789abcdef";
const TEST_AUTH_SECRET = "gotonghr-test-auth-secret-0123456789abcdef";

const placeholderAuthSecrets = new Set([
  "change-me",
  DEV_AUTH_SECRET,
  TEST_AUTH_SECRET,
]);

const placeholderBootstrapPasswords = new Set(["change-me-owner-password"]);

export function readDeploymentMode(env: NodeJS.ProcessEnv): DeploymentMode {
  const value = env.GOTONG_DEPLOYMENT_MODE ?? "single_tenant";
  if (!(deploymentModes as readonly string[]).includes(value)) {
    throw new Error("GOTONG_DEPLOYMENT_MODE is invalid.");
  }
  return value as DeploymentMode;
}

/** Production refuses the secrets published in `.env.example`. Tests may omit the variable. */
export function readAuthSecret(env: NodeJS.ProcessEnv): string {
  const configured = env.BETTER_AUTH_SECRET;
  if (configured) {
    if (configured.length < 32) {
      throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
    }
    if (env.NODE_ENV === "production" && placeholderAuthSecrets.has(configured)) {
      throw new Error("BETTER_AUTH_SECRET is still a placeholder.");
    }
    return configured;
  }
  if (env.NODE_ENV === "test") return TEST_AUTH_SECRET;
  throw new Error("Missing BETTER_AUTH_SECRET.");
}

export function readAuthBaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    throw new Error("BETTER_AUTH_URL must be an http(s) URL.");
  }
  return value.replace(/\/$/u, "");
}

export interface BootstrapInput {
  email: string;
  password: string;
  ownerName: string;
  tenantName: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function readBootstrapInput(env: NodeJS.ProcessEnv): BootstrapInput {
  const email = normalizeEmail(env.GOTONG_BOOTSTRAP_EMAIL ?? "");
  const password = env.GOTONG_BOOTSTRAP_PASSWORD ?? "";
  if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    throw new Error("GOTONG_BOOTSTRAP_EMAIL is invalid.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error("GOTONG_BOOTSTRAP_PASSWORD must be at least 12 characters.");
  }
  if (env.NODE_ENV === "production" && placeholderBootstrapPasswords.has(password)) {
    throw new Error("GOTONG_BOOTSTRAP_PASSWORD is still a placeholder.");
  }
  const ownerName = env.GOTONG_BOOTSTRAP_OWNER_NAME?.trim() || "Owner";
  const tenantName = env.GOTONG_BOOTSTRAP_TENANT_NAME?.trim() || "GotongHR";
  return { email, password, ownerName, tenantName };
}

export function readAuthRateLimit(env: NodeJS.ProcessEnv): { max: number; windowMs: number } {
  return {
    max: readPositiveInt(env.GOTONG_AUTH_RATE_LIMIT_MAX, 10, "GOTONG_AUTH_RATE_LIMIT_MAX"),
    windowMs: readPositiveInt(
      env.GOTONG_AUTH_RATE_LIMIT_WINDOW_MS,
      60_000,
      "GOTONG_AUTH_RATE_LIMIT_WINDOW_MS",
    ),
  };
}

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} is invalid.`);
  }
  return parsed;
}
