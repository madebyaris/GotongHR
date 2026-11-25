import { AsyncLocalStorage } from "node:async_hooks";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { TenantDatabase } from "@gotonghr/db";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { sessionCookieAttributes } from "./cookies.ts";
import {
  assertCanCreateOrganization,
  markSessionTotpVerified,
  provisionDirectory,
  recordSession,
  userIsSuspended,
} from "./directory.ts";
import { readAuthSecret, readDeploymentMode, readTrustedOrigins } from "./env.ts";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password.ts";
import { authSchema } from "./schema.ts";

const totpVerification = new AsyncLocalStorage<true>();

export interface CreateAuthInput {
  appDb: TenantDatabase;
  env?: NodeJS.ProcessEnv;
}

export interface GotongAuth {
  readonly api: {
    getSession: (input: { headers: Headers }) => Promise<unknown>;
    createOrganization: (input: {
      body: { name: string; slug: string; userId: string };
    }) => Promise<{ id: string } | null | undefined>;
  };
  readonly $context: Promise<{
    password: {
      hash: (password: string) => Promise<string>;
      verify: (data: { hash: string; password: string }) => Promise<boolean>;
    };
    internalAdapter: {
      findUserByEmail: (
        email: string,
        options?: { includeAccounts: true },
      ) => Promise<{
        user: { id: string; email: string };
        accounts: Array<{ providerId: string; password?: string | null }>;
      } | null>;
      createUser: (
        user: { email: string; name: string; emailVerified: true },
        source: { method: "admin" },
      ) => Promise<{ id: string; email: string }>;
      linkAccount: (account: {
        accountId: string;
        providerId: "credential";
        userId: string;
        password: string;
      }) => Promise<unknown>;
    };
  }>;
}

export function createAuth(input: CreateAuthInput): GotongAuth {
  const env = input.env ?? process.env;
  const secret = readAuthSecret(env);
  const trustedOrigins = readTrustedOrigins(env);
  const baseURL = trustedOrigins[0];
  if (!baseURL) throw new Error("Missing BETTER_AUTH_URL.");
  const deploymentMode = readDeploymentMode(env);
  const authDb = drizzle(input.appDb.pool, { schema: authSchema });

  return betterAuth({
    appName: "GotongHR",
    baseURL,
    secret,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
      sendResetPassword: async () => {
        // Mail delivery is a later slice. The route stays mounted so it can be rate limited.
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        organizationHooks: {
          beforeCreateOrganization: async () => {
            await assertCanCreateOrganization(input.appDb.pool, deploymentMode);
          },
          afterCreateOrganization: async ({ organization: created, user }) => {
            // Better Auth's member.role is not GotongHR RBAC. The directory row is org_owner.
            await provisionDirectory(input.appDb, {
              organizationId: created.id,
              name: created.name,
              slug: created.slug,
              authUserId: user.id,
              email: user.email,
              displayName: user.name,
            });
          },
        },
      }),
      twoFactor({
        issuer: "GotongHR",
        backupCodeOptions: {
          storeBackupCodes: "encrypted",
        },
      }),
    ],
    database: drizzleAdapter(authDb, {
      provider: "pg",
      schema: authSchema,
    }),
    databaseHooks: {
      session: {
        create: {
          // Runs after the password check and before the session row is inserted.
          // A suspended tenant must not receive a session.
          before: async (session) => {
            if (!session.userId) return;
            if (await userIsSuspended(input.appDb.pool, session.userId)) {
              throw new APIError("FORBIDDEN", {
                message: "Tenant is suspended.",
                code: "tenant_suspended",
              });
            }
          },
          after: async (session, context) => {
            const totpVerified =
              totpVerification.getStore() === true || isTotpVerificationPath(endpointPath(context));
            await recordSession(input.appDb, session, { totpVerified });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (isTotpVerificationPath(ctx.path ?? "")) totpVerification.enterWith(true);
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!isTotpVerificationPath(ctx.path ?? "")) return;
        if (!isSuccessfulAuthResult(ctx.context.returned)) return;
        const current = ctx.context.session?.session;
        const authUserId = current?.userId;
        const authSessionId = current?.id;
        if (!authUserId || !authSessionId) return;
        await markSessionTotpVerified(input.appDb, authUserId, authSessionId);
      }),
    },
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: sessionCookieAttributes.httpOnly,
        secure: sessionCookieAttributes.secure,
        sameSite: sessionCookieAttributes.sameSite,
      },
      database: {
        // "uuid" tells adapters that support it to omit the id and use a
        // database default. These tables are text primary keys, so the id is
        // generated here.
        generateId: () => crypto.randomUUID(),
      },
    },
    // The Fastify Postgres limiter is the one that counts login and reset.
    // Better Auth's own limiter is memory-backed and turns on in production.
    rateLimit: {
      enabled: false,
    },
    // The inferred Better Auth type names a nested Zod path that declaration
    // emit cannot reference. Callers use this structural type instead.
  }) as unknown as GotongAuth;
}

function endpointPath(context: object | null): string {
  if (!context || !("path" in context)) return "";
  const path = context.path;
  return typeof path === "string" ? path : "";
}

function isTotpVerificationPath(path: string): boolean {
  return path.endsWith("/two-factor/verify-totp") || path.endsWith("/two-factor/verify-backup-code");
}

function isSuccessfulAuthResult(returned: unknown): boolean {
  if (returned == null || typeof returned !== "object") return false;
  if ("statusCode" in returned && typeof returned.statusCode === "number" && returned.statusCode >= 400) {
    return false;
  }
  return true;
}
