import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { TenantDatabase } from "@gotonghr/db";
import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { sessionCookieAttributes } from "./cookies.ts";
import {
  assertCanCreateOrganization,
  provisionDirectory,
  recordSession,
} from "./directory.ts";
import { readAuthBaseUrl, readAuthSecret, readDeploymentMode } from "./env.ts";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password.ts";
import { authSchema } from "./schema.ts";

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
    password: { hash: (password: string) => Promise<string> };
    internalAdapter: {
      findUserByEmail: (
        email: string,
        options?: { includeAccounts: true },
      ) => Promise<{
        user: { id: string; email: string };
        accounts: Array<{ providerId: string }>;
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
  const baseURL = readAuthBaseUrl(env);
  const deploymentMode = readDeploymentMode(env);
  const authDb = drizzle(input.appDb.pool, { schema: authSchema });

  return betterAuth({
    appName: "GotongHR",
    baseURL,
    secret,
    trustedOrigins: [baseURL],
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
          after: async (session) => {
            await recordSession(input.appDb, session);
          },
        },
      },
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
