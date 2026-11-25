import { fail } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { etagMatches, strongEtag } from "./etag.ts";
import { MobileError } from "./errors.ts";
import { loadBootstrap } from "./service.ts";
import type { MobileCaller } from "./types.ts";

export interface MobileRouteDeps {
  database: TenantDatabase;
  guard: preHandlerHookHandler;
  readCaller: (request: FastifyRequest) => MobileCaller | null;
  now?: () => Date;
}

/**
 * `GET /api/v1/mobile/bootstrap` is the ESS document.
 * Payslip download waits for slice 4.5.
 */
export async function registerMobileRoutes(app: FastifyInstance, deps: MobileRouteDeps): Promise<void> {
  app.get("/api/v1/mobile/bootstrap", { preHandler: deps.guard }, async (request, reply) => {
    const caller = deps.readCaller(request);
    if (!caller) return reply.code(401).send(fail("unauthenticated", "Sign in required."));
    try {
      const data = await loadBootstrap(deps.database, caller, deps.now ? deps.now() : new Date());
      const json = JSON.stringify({ data, meta: null, error: null });
      const etag = strongEtag(json);
      reply.header("etag", etag);
      reply.header("cache-control", "private, no-cache");
      const ifNoneMatch = headerValue(request.headers["if-none-match"]);
      if (etagMatches(ifNoneMatch, etag)) return emptyNotModified(reply, etag);
      return reply.type("application/json; charset=utf-8").send(json);
    } catch (error) {
      if (error instanceof MobileError) return reply.code(error.status).send(fail(error.code, error.message));
      request.log.error({ err: error }, "bootstrap failed");
      return reply.code(500).send(fail("internal_error", "Request failed."));
    }
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function emptyNotModified(reply: FastifyReply, etag: string) {
  reply.header("etag", etag);
  reply.header("cache-control", "private, no-cache");
  reply.removeHeader("content-type");
  return reply.code(304).send();
}
