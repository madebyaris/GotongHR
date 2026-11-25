import { fail } from "@gotonghr/contracts";
import rateLimit from "@fastify/rate-limit";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance } from "fastify";
import fastifyBetterAuth from "fastify-better-auth";
import type { GotongAuth } from "./auth.ts";
import type { GotongAuthContext } from "./guard.ts";
import { readAuthRateLimit, readTrustCloudflare, readTrustProxy } from "./env.ts";
import { registerOrgRoutes } from "./org-routes.ts";
import { createPostgresRateLimitStore, isCredentialRoute, rateLimitKey } from "./rate-limit.ts";

export interface IdentityHandle {
  auth: GotongAuth;
  appDb: TenantDatabase;
}

declare module "fastify" {
  interface FastifyInstance {
    gotongIdentity: IdentityHandle;
  }
  interface FastifyRequest {
    gotongAuth: GotongAuthContext | null;
  }
}

export interface RegisterIdentityOptions {
  auth: GotongAuth;
  appDb: TenantDatabase;
  env?: NodeJS.ProcessEnv;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export async function registerIdentity(
  app: FastifyInstance,
  options: RegisterIdentityOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const configured = readAuthRateLimit(env);
  const trustCloudflare = readTrustCloudflare(env);
  const trustProxy = readTrustProxy(env);
  const max = options.rateLimitMax ?? configured.max;
  const windowMs = options.rateLimitWindowMs ?? configured.windowMs;
  app.decorate("gotongIdentity", { auth: options.auth, appDb: options.appDb });
  app.decorateRequest("gotongAuth", null);
  await app.register(async function authHttp(scope) {
    scope.setErrorHandler((error: unknown, request, reply) => {
      const statusCode = readStatusCode(error);
      if (statusCode === 429) {
        return reply.code(429).send(fail("rate_limited", "Too many attempts."));
      }
      if (statusCode >= 500) {
        request.log.error({ err: error }, "auth request failed");
        return reply.code(statusCode).send(fail("internal_error", "Request failed."));
      }
      const normalized = error instanceof Error ? error : new Error("Request failed.");
      return reply.code(statusCode).send(normalized);
    });
    await scope.register(rateLimit, {
      global: true,
      max,
      timeWindow: windowMs,
      store: createPostgresRateLimitStore(options.appDb.pool),
      keyGenerator: (request) => rateLimitKey(request, trustCloudflare, trustProxy),
      allowList: (request) => !isCredentialRoute(request.url),
      errorResponseBuilder: (_request, context) =>
        Object.assign(new Error("Too many attempts."), { statusCode: context.statusCode }),
    });
    if (env.NODE_ENV === "test") {
      scope.get("/api/auth/__test/fail", async () => {
        throw Object.assign(new Error("database password=secret"), { statusCode: 500 });
      });
    }
    await scope.register(fastifyBetterAuth, { auth: options.auth });
    await registerOrgRoutes(scope);
  });
}

function readStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = error.statusCode;
    if (typeof statusCode === "number") return statusCode;
  }
  return 500;
}
