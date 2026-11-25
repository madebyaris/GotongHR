import {
  fail,
  failWithFields,
  isRealIsoDate,
  ok,
  parseCompensationCreate,
  parseContractCreate,
  parseDepartmentCreate,
  parseDepartmentPatch,
  parsePositionCreate,
  parsePositionPatch,
  type PermissionAtom,
} from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { CoreHrAuth } from "../auth.ts";
import { EmployeeForbiddenError } from "../errors.ts";
import { appendCompensation, compensationEffectiveOn, listCompensation } from "./compensation.ts";
import { createContract, listContracts } from "./contracts.ts";
import { createDepartment, deleteDepartment, getDepartment, listDepartments, updateDepartment } from "./departments.ts";
import { mapOrgError, OrgConflictError, OrgFieldError, OrgNotFoundError } from "./errors.ts";
import { createPosition, deletePosition, getPosition, listPositions, updatePosition } from "./positions.ts";

interface OrgRouteDeps {
  appDb: TenantDatabase;
  guard: (permission: PermissionAtom) => preHandlerHookHandler;
  readAuth: (request: FastifyRequest) => CoreHrAuth | null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Departments, positions, contracts, and compensation use the employee read and write atoms. */
export async function registerOrgRoutes(app: FastifyInstance, deps: OrgRouteDeps): Promise<void> {
  app.get("/api/v1/departments", { preHandler: guard(deps, "employee.read") }, async (request, reply) => {
    const page = parsePage(request.query);
    const entity = readOptionalUuid(queryRecord(request.query).legalEntityId, "legalEntityId");
    if (!page.ok) return invalid(reply, page.fields);
    if (!entity.ok) return invalid(reply, [{ field: "legalEntityId", message: entity.message }]);
    return run(deps, request, reply, (auth) =>
      listDepartments(deps.appDb, auth, page.value, entity.value).then((rows) => ok(rows, page.value)),
    );
  });

  app.post("/api/v1/departments", { preHandler: guard(deps, "employee.write") }, async (request, reply) => {
    const parsed = parseDepartmentCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, async (auth) => {
      const created = await createDepartment(deps.appDb, auth, parsed.value);
      return reply.code(201).send(ok(created));
    });
  });

  app.get("/api/v1/departments/:id", { preHandler: guard(deps, "employee.read") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply, "That department was not found.");
    return run(deps, request, reply, async (auth) => {
      const row = await getDepartment(deps.appDb, auth, id);
      if (!row) return missing(reply, "That department was not found.");
      return ok(row);
    });
  });

  app.patch("/api/v1/departments/:id", { preHandler: guard(deps, "employee.write") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply, "That department was not found.");
    const parsed = parseDepartmentPatch(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, (auth) =>
      updateDepartment(deps.appDb, auth, id, parsed.value).then((row) => ok(row)),
    );
  });

  app.delete("/api/v1/departments/:id", { preHandler: guard(deps, "employee.write") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply, "That department was not found.");
    return run(deps, request, reply, async (auth) => {
      await deleteDepartment(deps.appDb, auth, id);
      return ok({ id });
    });
  });

  app.get("/api/v1/positions", { preHandler: guard(deps, "employee.read") }, async (request, reply) => {
    const page = parsePage(request.query);
    const department = readOptionalUuid(queryRecord(request.query).departmentId, "departmentId");
    if (!page.ok) return invalid(reply, page.fields);
    if (!department.ok) return invalid(reply, [{ field: "departmentId", message: department.message }]);
    return run(deps, request, reply, (auth) =>
      listPositions(deps.appDb, auth, page.value, department.value).then((rows) => ok(rows, page.value)),
    );
  });

  app.post("/api/v1/positions", { preHandler: guard(deps, "employee.write") }, async (request, reply) => {
    const parsed = parsePositionCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, async (auth) => {
      const created = await createPosition(deps.appDb, auth, parsed.value);
      return reply.code(201).send(ok(created));
    });
  });

  app.get("/api/v1/positions/:id", { preHandler: guard(deps, "employee.read") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply, "That position was not found.");
    return run(deps, request, reply, async (auth) => {
      const row = await getPosition(deps.appDb, auth, id);
      if (!row) return missing(reply, "That position was not found.");
      return ok(row);
    });
  });

  app.patch("/api/v1/positions/:id", { preHandler: guard(deps, "employee.write") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply, "That position was not found.");
    const parsed = parsePositionPatch(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, (auth) => updatePosition(deps.appDb, auth, id, parsed.value).then((row) => ok(row)));
  });

  app.delete("/api/v1/positions/:id", { preHandler: guard(deps, "employee.write") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply, "That position was not found.");
    return run(deps, request, reply, async (auth) => {
      await deletePosition(deps.appDb, auth, id);
      return ok({ id });
    });
  });

  app.get(
    "/api/v1/employees/:id/contracts",
    { preHandler: guard(deps, "employee.read") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply, "That employee was not found.");
      const page = parsePage(request.query);
      if (!page.ok) return invalid(reply, page.fields);
      return run(deps, request, reply, (auth) =>
        listContracts(deps.appDb, auth, id, page.value).then((rows) => ok(rows, page.value)),
      );
    },
  );

  app.post(
    "/api/v1/employees/:id/contracts",
    { preHandler: guard(deps, "employee.write") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply, "That employee was not found.");
      const parsed = parseContractCreate(request.body);
      if (!parsed.ok) return invalid(reply, parsed.fields);
      return run(deps, request, reply, async (auth) => {
        const created = await createContract(deps.appDb, auth, id, parsed.value);
        return reply.code(201).send(ok(created));
      });
    },
  );

  app.get(
    "/api/v1/employees/:id/compensation-profiles/effective",
    { preHandler: guard(deps, "employee.read") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply, "That employee was not found.");
      const on = readOn(queryRecord(request.query).on);
      if (!on.ok) return invalid(reply, [{ field: "on", message: on.message }]);
      return run(deps, request, reply, async (auth) => {
        const found = await compensationEffectiveOn(deps.appDb, auth, id, on.value);
        if (!found) return missing(reply, "No compensation profile is effective on that date.");
        return ok(found.profile);
      });
    },
  );

  app.get(
    "/api/v1/employees/:id/compensation-profiles",
    { preHandler: guard(deps, "employee.read") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply, "That employee was not found.");
      const page = parsePage(request.query);
      if (!page.ok) return invalid(reply, page.fields);
      return run(deps, request, reply, (auth) =>
        listCompensation(deps.appDb, auth, id, page.value).then((rows) => ok(rows, page.value)),
      );
    },
  );

  app.post(
    "/api/v1/employees/:id/compensation-profiles",
    { preHandler: guard(deps, "employee.write") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply, "That employee was not found.");
      const parsed = parseCompensationCreate(request.body);
      if (!parsed.ok) return invalid(reply, parsed.fields);
      return run(deps, request, reply, async (auth) => {
        const created = await appendCompensation(deps.appDb, auth, id, parsed.value);
        return reply.code(201).send(ok(created));
      });
    },
  );
}

function guard(deps: OrgRouteDeps, permission: PermissionAtom) {
  return deps.guard(permission);
}

async function run(
  deps: OrgRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (auth: CoreHrAuth) => Promise<unknown>,
): Promise<unknown> {
  const auth = deps.readAuth(request);
  if (!auth) return reply.code(500).send(fail("internal_error", "Request failed."));
  try {
    return await fn(auth);
  } catch (error) {
    const mapped = mapOrgError(error);
    if (mapped instanceof OrgFieldError) return invalid(reply, mapped.fields);
    if (mapped instanceof OrgNotFoundError) return missing(reply, mapped.message);
    if (mapped instanceof OrgConflictError) {
      return reply.code(409).send(failWithFields("conflict", mapped.message, mapped.fields));
    }
    if (mapped instanceof EmployeeForbiddenError) {
      return reply.code(403).send(fail("forbidden", mapped.message));
    }
    request.log.error({ err: mapped }, "org request failed");
    return reply.code(500).send(fail("internal_error", "Request failed."));
  }
}

function invalid(reply: FastifyReply, fields: { field: string; message: string }[]) {
  return reply.code(400).send(failWithFields("invalid_field", "Check the highlighted fields.", fields));
}

function missing(reply: FastifyReply, message: string) {
  return reply.code(404).send(fail("not_found", message));
}

function routeId(params: unknown): string | null {
  if (!params || typeof params !== "object" || !("id" in params)) return null;
  const id = params.id;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  return id.toLowerCase();
}

function queryRecord(query: unknown): Record<string, unknown> {
  return query && typeof query === "object" ? (query as Record<string, unknown>) : {};
}

function readOptionalUuid(
  value: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: null };
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !UUID.test(text)) return { ok: false, message: `Choose a valid ${field}.` };
  return { ok: true, value: text.toLowerCase() };
}

function readOn(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !isRealIsoDate(text)) {
    return { ok: false, message: "Enter the effective date as YYYY-MM-DD." };
  }
  return { ok: true, value: text };
}

function parsePage(query: unknown):
  | { ok: true; value: { limit: number; offset: number } }
  | { ok: false; fields: { field: string; message: string }[] } {
  const record = queryRecord(query);
  const fields: { field: string; message: string }[] = [];
  const limit = parseBound(record.limit, 50, 1, 100, "Use a limit from 1 to 100.");
  const offset = parseBound(record.offset, 0, 0, 100_000, "Use an offset from 0 to 100000.");
  if (!limit.ok) fields.push({ field: "limit", message: limit.message });
  if (!offset.ok) fields.push({ field: "offset", message: offset.message });
  if (!limit.ok || !offset.ok) return { ok: false, fields };
  return { ok: true, value: { limit: limit.value, offset: offset.value } };
}

function parseBound(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  message: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback };
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !/^[0-9]+$/u.test(text)) return { ok: false, message };
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return { ok: false, message };
  return { ok: true, value: parsed };
}
