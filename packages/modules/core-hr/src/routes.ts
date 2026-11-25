import {
  PiiRevealDeniedError,
  PiiRevealReasonError,
  SupportGrantPiiDeniedError,
} from "@gotonghr/audit/reveal";
import {
  fail,
  failWithFields,
  ok,
  parseCompensationCreate,
  parseContractCreate,
  parseDepartmentCreate,
  parseEmployeeCreate,
  parseEmployeePatch,
  parsePiiReveal,
  parsePositionCreate,
  type PermissionAtom,
} from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { CoreHrAuth } from "./auth.ts";
import {
  EmployeeConflictError,
  EmployeeFieldError,
  EmployeeForbiddenError,
  EmployeeNotFoundError,
} from "./errors.ts";
import {
  createCompensation,
  createContract,
  createDepartment,
  createPosition,
  listCompensation,
  listContracts,
  listDepartments,
  listPositions,
} from "./directory/service.ts";
import { getEmployee, listEmployees } from "./read.ts";
import { revealEmployeePii } from "./reveal.ts";
import { createEmployee, updateEmployee } from "./write.ts";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface CoreHrRouteDeps {
  appDb: TenantDatabase;
  guard: (permission: PermissionAtom) => preHandlerHookHandler;
  readAuth: (request: FastifyRequest) => CoreHrAuth | null;
}

export async function registerCoreHr(app: FastifyInstance, deps: CoreHrRouteDeps): Promise<void> {
  app.get("/api/v1/employees", { preHandler: deps.guard("employee.read") }, async (request, reply) => {
    const page = parsePage(request.query);
    if (!page.ok) return invalid(reply, page.fields);
    return run(deps, request, reply, (auth) =>
      listEmployees(deps.appDb, auth, page.value).then((rows) => ok(rows, page.value)),
    );
  });

  app.post("/api/v1/employees", { preHandler: deps.guard("employee.write") }, async (request, reply) => {
    const parsed = parseEmployeeCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, async (auth) => {
      const created = await createEmployee(deps.appDb, auth, parsed.value);
      return reply.code(201).send(ok(created));
    });
  });

  app.get("/api/v1/employees/:id", { preHandler: deps.guard("employee.read") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply);
    return run(deps, request, reply, async (auth) => {
      const row = await getEmployee(deps.appDb, auth, id);
      if (!row) return missing(reply);
      return ok(row);
    });
  });

  app.patch("/api/v1/employees/:id", { preHandler: deps.guard("employee.write") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply);
    const parsed = parseEmployeePatch(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, (auth) =>
      updateEmployee(deps.appDb, auth, id, parsed.value).then((row) => ok(row)),
    );
  });

  app.get("/api/v1/departments", { preHandler: deps.guard("employee.read") }, async (request, reply) => {
    return run(deps, request, reply, (auth) => listDepartments(deps.appDb, auth).then((rows) => ok(rows)));
  });

  app.post("/api/v1/departments", { preHandler: deps.guard("employee.write") }, async (request, reply) => {
    const parsed = parseDepartmentCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, async (auth) => {
      const created = await createDepartment(deps.appDb, auth, parsed.value.name);
      return reply.code(201).send(ok(created));
    });
  });

  app.get("/api/v1/positions", { preHandler: deps.guard("employee.read") }, async (request, reply) => {
    return run(deps, request, reply, (auth) => listPositions(deps.appDb, auth).then((rows) => ok(rows)));
  });

  app.post("/api/v1/positions", { preHandler: deps.guard("employee.write") }, async (request, reply) => {
    const parsed = parsePositionCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, async (auth) => {
      const created = await createPosition(deps.appDb, auth, parsed.value);
      return reply.code(201).send(ok(created));
    });
  });

  app.get("/api/v1/employees/:id/contracts", { preHandler: deps.guard("employee.read") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply);
    return run(deps, request, reply, (auth) => listContracts(deps.appDb, auth, id).then((rows) => ok(rows)));
  });

  app.post("/api/v1/employees/:id/contracts", { preHandler: deps.guard("employee.write") }, async (request, reply) => {
    const id = routeId(request.params);
    if (!id) return missing(reply);
    const parsed = parseContractCreate(request.body);
    if (!parsed.ok) return invalid(reply, parsed.fields);
    return run(deps, request, reply, async (auth) => {
      const created = await createContract(deps.appDb, auth, id, parsed.value);
      return reply.code(201).send(ok(created));
    });
  });

  app.get(
    "/api/v1/employees/:id/compensation-profiles",
    { preHandler: deps.guard("employee.read") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply);
      return run(deps, request, reply, (auth) => listCompensation(deps.appDb, auth, id).then((rows) => ok(rows)));
    },
  );

  app.post(
    "/api/v1/employees/:id/compensation-profiles",
    { preHandler: deps.guard("employee.write") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply);
      const parsed = parseCompensationCreate(request.body);
      if (!parsed.ok) return invalid(reply, parsed.fields);
      return run(deps, request, reply, async (auth) => {
        const created = await createCompensation(deps.appDb, auth, id, parsed.value);
        return reply.code(201).send(ok(created));
      });
    },
  );

  app.post(
    "/api/v1/employees/:id/pii/reveal",
    { preHandler: deps.guard("employee.pii.reveal") },
    async (request, reply) => {
      const id = routeId(request.params);
      if (!id) return missing(reply);
      const parsed = parsePiiReveal(request.body);
      if (!parsed.ok) return invalid(reply, parsed.fields);
      return run(deps, request, reply, (auth) =>
        revealEmployeePii(deps.appDb, auth, id, parsed.value).then((revealed) => ok(revealed)),
      );
    },
  );
}

async function run(
  deps: CoreHrRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (auth: CoreHrAuth) => Promise<unknown>,
): Promise<unknown> {
  const auth = deps.readAuth(request);
  if (!auth) return reply.code(500).send(fail("internal_error", "Request failed."));
  try {
    return await fn(auth);
  } catch (error) {
    if (error instanceof EmployeeFieldError) return invalid(reply, error.fields);
    if (error instanceof EmployeeNotFoundError) return missing(reply);
    if (error instanceof EmployeeConflictError) {
      return reply.code(409).send(failWithFields("conflict", error.message, error.fields));
    }
    if (error instanceof EmployeeForbiddenError) {
      return reply.code(403).send(fail("forbidden", error.message));
    }
    if (error instanceof PiiRevealDeniedError) {
      return reply.code(403).send(fail("forbidden", error.message));
    }
    if (error instanceof SupportGrantPiiDeniedError) {
      return reply.code(403).send(fail("pii_reveal_denied", error.message));
    }
    if (error instanceof PiiRevealReasonError) {
      return reply.code(400).send(fail("reason_required", error.message));
    }
    request.log.error({ err: error }, "employee request failed");
    return reply.code(500).send(fail("internal_error", "Request failed."));
  }
}

function invalid(reply: FastifyReply, fields: { field: string; message: string }[]) {
  return reply.code(400).send(failWithFields("invalid_field", "Check the highlighted fields.", fields));
}

function missing(reply: FastifyReply) {
  return reply.code(404).send(fail("not_found", "That employee was not found."));
}

function routeId(params: unknown): string | null {
  if (!params || typeof params !== "object" || !("id" in params)) return null;
  const id = params.id;
  if (typeof id !== "string" || !uuid.test(id)) return null;
  return id.toLowerCase();
}

function parsePage(query: unknown):
  | { ok: true; value: { limit: number; offset: number } }
  | { ok: false; fields: { field: string; message: string }[] } {
  const record = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
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
