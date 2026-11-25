import { fail, failWithFields, ok, parseBranchCreate, parseBranchPatch, parseLegalEntityCreate, parseLegalEntityPatch } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GotongAuthContext } from "./guard.ts";
import { requireMember, requireOrgWriter } from "./guard.ts";
import {
  OrgConflictError,
  OrgFieldError,
  OrgForbiddenError,
  OrgNotFoundError,
  createBranch,
  createLegalEntity,
  listBranches,
  listLegalEntities,
  loadContext,
  updateBranch,
  updateLegalEntity,
} from "./org.ts";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function registerOrgRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/me/context", { preHandler: requireMember() }, async (request, reply) =>
    run(request, reply, (auth, db) => loadContext(db, auth).then((context) => ok(context))),
  );

  app.get("/api/v1/legal-entities", { preHandler: requireMember() }, async (request, reply) =>
    run(request, reply, (auth, db) => listLegalEntities(db, auth).then((rows) => ok(rows))),
  );

  app.post("/api/v1/legal-entities", { preHandler: requireOrgWriter() }, async (request, reply) => {
    const parsed = parseLegalEntityCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(request, reply, async (auth, db) => {
      const created = await createLegalEntity(db, auth, parsed.value);
      return reply.code(201).send(ok(created));
    });
  });

  app.patch("/api/v1/legal-entities/:id", { preHandler: requireOrgWriter() }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply);
    const parsed = parseLegalEntityPatch(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(request, reply, (auth, db) => updateLegalEntity(db, auth, id, parsed.value).then((row) => ok(row)));
  });

  app.get("/api/v1/branches", { preHandler: requireMember() }, async (request, reply) =>
    run(request, reply, (auth, db) => listBranches(db, auth).then((rows) => ok(rows))),
  );

  app.post("/api/v1/branches", { preHandler: requireOrgWriter() }, async (request, reply) => {
    const parsed = parseBranchCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(request, reply, async (auth, db) => {
      const created = await createBranch(db, auth, parsed.value);
      return reply.code(201).send(ok(created));
    });
  });

  app.patch("/api/v1/branches/:id", { preHandler: requireOrgWriter() }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply);
    const parsed = parseBranchPatch(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(request, reply, (auth, db) => updateBranch(db, auth, id, parsed.value).then((row) => ok(row)));
  });
}

async function run(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (auth: GotongAuthContext, db: TenantDatabase) => Promise<unknown>,
): Promise<unknown> {
  const auth = request.gotongAuth;
  const handle = request.server.gotongIdentity;
  if (!auth || !handle) return reply.code(500).send(fail("internal_error", "Request failed."));
  try {
    return await fn(auth, handle.appDb);
  } catch (error) {
    if (error instanceof OrgFieldError) return invalid(reply, error.fields);
    if (error instanceof OrgNotFoundError) return missing(reply);
    if (error instanceof OrgConflictError) {
      return reply.code(409).send(failWithFields("conflict", error.message, error.fields));
    }
    if (error instanceof OrgForbiddenError) return reply.code(403).send(fail("forbidden", error.message));
    request.log.error({ err: error }, "org request failed");
    return reply.code(500).send(fail("internal_error", "Request failed."));
  }
}

function invalid(reply: FastifyReply, fields: { field: string; message: string }[]) {
  return reply.code(400).send(failWithFields("invalid_field", "Check the highlighted fields.", fields));
}

function missing(reply: FastifyReply) {
  return reply.code(404).send(fail("not_found", "That record was not found."));
}

function routeId(params: unknown): string | null {
  if (!params || typeof params !== "object" || !("id" in params)) return null;
  const id = params.id;
  if (typeof id !== "string" || !uuid.test(id)) return null;
  return id.toLowerCase();
}
