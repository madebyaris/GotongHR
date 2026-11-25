import { createHash } from "node:crypto";
import type { RoleCode } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import pg from "pg";
import type { GotongAuth } from "./auth.ts";
import {
  insertMembership,
  singleTenantOwner,
  tenantCount,
  tenantIdForOrganization,
} from "./directory.ts";
import { normalizeEmail, type DeploymentMode } from "./env.ts";
import { SingleTenantOccupiedError } from "./errors.ts";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password.ts";

const SINGLE_TENANT_LOCK = "gotonghr.single_tenant.bootstrap";
const SLUG_MAX = 64;

export interface BootstrapResult {
  tenantId: string;
  organizationId: string;
  authUserId: string;
  created: boolean;
}

export interface CredentialUserInput {
  email: string;
  password: string;
  name: string;
}

/**
 * One organization is one id_tenants row. Call this without request headers:
 * a header makes Better Auth treat the call as a browser session and reject it.
 */
export async function createTenantWithOwner(
  auth: GotongAuth,
  appDb: TenantDatabase,
  input: CredentialUserInput & { tenantName: string },
): Promise<BootstrapResult> {
  const user = await ensureCredentialUser(auth, input);
  const slug = tenantSlug(input.tenantName);
  const created = await auth.api.createOrganization({
    body: {
      name: input.tenantName,
      slug,
      userId: user.id,
    },
  });
  if (!created || typeof created.id !== "string") {
    throw new Error("Organization was not created.");
  }
  const tenantId = await tenantIdForOrganization(appDb.pool, created.id);
  if (!tenantId) throw new Error("Organization was not linked to a tenant.");
  return {
    tenantId,
    organizationId: created.id,
    authUserId: user.id,
    created: true,
  };
}

export async function bootstrapOwner(
  auth: GotongAuth,
  appDb: TenantDatabase,
  input: CredentialUserInput & { tenantName: string },
  mode: DeploymentMode,
): Promise<BootstrapResult> {
  if (mode !== "single_tenant") {
    throw new Error("bootstrap is only available when GOTONG_DEPLOYMENT_MODE=single_tenant");
  }
  const email = normalizeEmail(input.email);
  const client = await connectOutsidePool(appDb);
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [SINGLE_TENANT_LOCK]);
    const count = await tenantCount(appDb.pool);
    if (count > 1) throw new SingleTenantOccupiedError();
    if (count === 1) {
      const owner = await singleTenantOwner(appDb.pool);
      if (!owner) throw new Error("single_tenant has a tenant without an org_owner.");
      if (normalizeEmail(owner.email) !== email) throw new SingleTenantOccupiedError();
      await ensureCredentialUser(auth, { ...input, email });
      return {
        tenantId: owner.tenantId,
        organizationId: owner.organizationId,
        authUserId: owner.authUserId,
        created: false,
      };
    }
    return await createTenantWithOwner(auth, appDb, { ...input, email });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [SINGLE_TENANT_LOCK]).catch(
      () => undefined,
    );
    await client.end();
  }
}

export async function grantMembership(
  auth: GotongAuth,
  appDb: TenantDatabase,
  input: CredentialUserInput & { tenantId: string; role: RoleCode },
): Promise<{ authUserId: string; userId: string }> {
  const user = await ensureCredentialUser(auth, input);
  const userId = await insertMembership(appDb, {
    tenantId: input.tenantId,
    authUserId: user.id,
    email: user.email,
    displayName: input.name,
    role: input.role,
  });
  return { authUserId: user.id, userId };
}

export async function ensureCredentialUser(
  auth: GotongAuth,
  input: CredentialUserInput,
): Promise<{ id: string; email: string }> {
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password length is outside the allowed range.");
  }
  const email = normalizeEmail(input.email);
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
  if (existing) {
    const credential = existing.accounts.find((account) => account.providerId === "credential");
    if (!credential?.password) {
      await ctx.internalAdapter.linkAccount({
        accountId: existing.user.id,
        providerId: "credential",
        userId: existing.user.id,
        password: await ctx.password.hash(input.password),
      });
    } else {
      const matches = await ctx.password.verify({
        hash: credential.password,
        password: input.password,
      });
      if (!matches) throw new Error("Password does not match the existing account.");
    }
    return { id: existing.user.id, email: existing.user.email };
  }
  const user = await ctx.internalAdapter.createUser(
    { email, name: input.name, emailVerified: true },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({
    accountId: user.id,
    providerId: "credential",
    userId: user.id,
    password: await ctx.password.hash(input.password),
  });
  return { id: user.id, email: user.email };
}

export function tenantSlug(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) throw new Error("Tenant name is empty.");
  const base = trimmed.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  const suffix = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  if (!base) return `tenant-${suffix}`;
  if (base.length <= SLUG_MAX) return base;
  const room = SLUG_MAX - suffix.length - 1;
  return `${base.slice(0, room)}-${suffix}`;
}

async function connectOutsidePool(appDb: TenantDatabase): Promise<pg.Client> {
  const connectionString = appDb.pool.options.connectionString;
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("database url is missing");
  }
  const client = new pg.Client({ connectionString });
  client.on("error", (error: Error) => {
    process.stderr.write(
      `${JSON.stringify({ msg: "bootstrap lock client error", error: error.message })}\n`,
    );
  });
  await client.connect();
  return client;
}
