import { fail, failWithFields, ok } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { AnomalyError } from "./errors.ts";
import { listPendingAnomalies } from "./query.ts";
import { cleanNote, reviewAnomaly } from "./service.ts";
import { isUuid } from "./sql.ts";
import type { AnomalyCaller } from "./types.ts";

export interface AnomalyRouteDeps {
  database: TenantDatabase;
  guard: preHandlerHookHandler;
  readCaller: (request: FastifyRequest) => AnomalyCaller | null;
}

/**
 * The web inbox and the phone inbox both call listPendingAnomalies.
 * Do not query att_clock_events from this file.
 */
export async function registerAnomalyRoutes(
  app: FastifyInstance,
  deps: AnomalyRouteDeps,
): Promise<void> {
  app.get("/api/v1/attendance/anomalies", { preHandler: deps.guard }, (request, reply) =>
    pending(deps, request, reply),
  );
  app.get("/api/v1/mobile/approvals/pending", { preHandler: deps.guard }, (request, reply) =>
    pending(deps, request, reply),
  );
  app.post("/api/v1/attendance/anomalies/:id/review", { preHandler: deps.guard }, async (request, reply) => {
    const caller = callerOr401(deps, request, reply);
    if (!caller) return;
    const id = routeId(request);
    if (!id) return reply.code(404).send(fail("not_found", "Punch not found."));
    try {
      const reviewed = await reviewAnomaly(deps.database, caller, id, parseNote(request.body));
      return reply.send(ok(reviewed));
    } catch (error) {
      return failed(request, reply, error);
    }
  });
}

async function pending(
  deps: AnomalyRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const caller = callerOr401(deps, request, reply);
  if (!caller) return;
  try {
    const anomalies = await listPendingAnomalies(deps.database, caller);
    await reply.send(ok(anomalies));
  } catch (error) {
    await failed(request, reply, error);
  }
}

function parseNote(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new AnomalyError(400, "invalid_field", "Check the highlighted fields.", [
      { field: "body", message: "Send a JSON object." },
    ]);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "note") {
      throw new AnomalyError(400, "invalid_field", "Check the highlighted fields.", [
        { field: key, message: "Unknown field." },
      ]);
    }
  }
  if (!Object.hasOwn(record, "note") || record.note === null) return null;
  if (typeof record.note !== "string") {
    throw new AnomalyError(400, "invalid_field", "Check the highlighted fields.", [
      { field: "note", message: "Note must be text." },
    ]);
  }
  return cleanNote(record.note);
}

function callerOr401(
  deps: AnomalyRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): AnomalyCaller | null {
  const caller = deps.readCaller(request);
  if (caller) return caller;
  void reply.code(401).send(fail("unauthenticated", "Sign in required."));
  return null;
}

function routeId(request: FastifyRequest): string | null {
  const params = request.params as { id?: unknown };
  return typeof params.id === "string" && isUuid(params.id) ? params.id : null;
}

function failed(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof AnomalyError) {
    if (error.fields.length > 0) {
      return reply.code(error.status).send(failWithFields(error.code, error.message, error.fields));
    }
    return reply.code(error.status).send(fail(error.code, error.message));
  }
  request.log.error({ err: error }, "anomaly request failed");
  return reply.code(500).send(fail("internal_error", "Request failed."));
}
