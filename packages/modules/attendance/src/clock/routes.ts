import { fail, failWithFields, ok } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { ObjectStorage } from "@gotonghr/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { ClockFieldError, ClockForbiddenError } from "./errors.ts";
import { parseSelfieUpload, parseSyncBody } from "./parse.ts";
import { createSelfieUpload, syncClockEvents } from "./service.ts";
import type { ClockCaller } from "./types.ts";

export interface ClockRouteDeps {
  database: TenantDatabase;
  storage: ObjectStorage;
  guard: preHandlerHookHandler;
  readCaller: (request: FastifyRequest) => ClockCaller | null;
  now?: () => Date;
}

export async function registerClockRoutes(app: FastifyInstance, deps: ClockRouteDeps): Promise<void> {
  app.post(
    "/api/v1/mobile/attendance/selfie-upload-url",
    { preHandler: deps.guard },
    async (request, reply) => {
      const caller = callerOr401(deps, request, reply);
      if (!caller) return;
      const parsed = parseSelfieUpload(request.body);
      if (!parsed.ok) return invalid(reply, parsed.fields);
      try {
        const upload = await createSelfieUpload(deps.storage, caller, parsed.value);
        return reply.send(ok(upload));
      } catch (error) {
        return failed(request, reply, error);
      }
    },
  );

  app.post("/api/v1/mobile/attendance/sync", { preHandler: deps.guard }, async (request, reply) => {
    const caller = callerOr401(deps, request, reply);
    if (!caller) return;
    const parsed = parseSyncBody(request.body, caller.tenantId);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    try {
      const events = await syncClockEvents(deps.database, caller, parsed.value, deps.now?.() ?? new Date());
      return reply.send(ok({ events }));
    } catch (error) {
      if (error instanceof ClockFieldError) return invalid(reply, error.fields);
      if (error instanceof ClockForbiddenError) {
        return reply.code(403).send(fail("forbidden", error.message));
      }
      return failed(request, reply, error);
    }
  });
}

function callerOr401(deps: ClockRouteDeps, request: FastifyRequest, reply: FastifyReply): ClockCaller | null {
  const caller = deps.readCaller(request);
  if (caller) return caller;
  void reply.code(401).send(fail("unauthenticated", "Sign in required."));
  return null;
}

function invalid(reply: FastifyReply, fields: { field: string; message: string }[]) {
  return reply.code(400).send(failWithFields("invalid_field", "Check the highlighted fields.", fields));
}

function failed(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  request.log.error({ err: error }, "clock request failed");
  return reply.code(500).send(fail("internal_error", "Request failed."));
}
