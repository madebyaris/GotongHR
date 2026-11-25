import { fail, failWithFields, ok, type PermissionAtom } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { ObjectStorage } from "@gotonghr/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { CoreHrAuth } from "../auth.ts";
import { EmployeeConflictError, EmployeeFieldError, EmployeeForbiddenError } from "../errors.ts";
import { createEmployeeImport, createImportUpload, getEmployeeImport, ImportNotFoundError } from "./service.ts";
import type { EmployeeImportMessage } from "./queue.ts";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface EmployeeImportRouteDeps {
  appDb: TenantDatabase;
  storage: ObjectStorage;
  guard: (permission: PermissionAtom) => preHandlerHookHandler;
  readAuth: (request: FastifyRequest) => CoreHrAuth | null;
  enqueueEmployeeImport: (message: EmployeeImportMessage) => Promise<void>;
}

export async function registerEmployeeImports(app: FastifyInstance, deps: EmployeeImportRouteDeps): Promise<void> {
  app.post(
    "/api/v1/employees/import/upload-url",
    { preHandler: deps.guard("employee.write") },
    async (request, reply) => {
      const body = request.body as { byteSize?: unknown } | undefined;
      return run(deps, request, reply, (auth) =>
        createImportUpload(deps.appDb, deps.storage, auth, body?.byteSize).then((upload) => ok(upload)),
      );
    },
  );

  app.post(
    "/api/v1/employees/import",
    { preHandler: deps.guard("employee.write") },
    async (request, reply) => {
      return run(deps, request, reply, (auth) =>
        createEmployeeImport(
          deps.appDb,
          deps.storage,
          auth,
          request.body as Record<string, unknown>,
          deps.enqueueEmployeeImport,
        ).then((job) => reply.code(202).send(ok(job))),
      );
    },
  );

  app.get(
    "/api/v1/employees/import/:jobId",
    { preHandler: deps.guard("employee.read") },
    async (request, reply) => {
      const jobId = routeId(request.params);
      if (!jobId) return missing(reply);
      return run(deps, request, reply, (auth) => getEmployeeImport(deps.appDb, auth, jobId).then((job) => ok(job)));
    },
  );
}

async function run(
  deps: EmployeeImportRouteDeps,
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
    if (error instanceof ImportNotFoundError) return missing(reply);
    if (error instanceof EmployeeConflictError) {
      return reply.code(409).send(failWithFields("conflict", error.message, error.fields));
    }
    if (error instanceof EmployeeForbiddenError) {
      return reply.code(403).send(fail("forbidden", error.message));
    }
    request.log.error({ err: error }, "employee import failed");
    return reply.code(500).send(fail("internal_error", "Request failed."));
  }
}

function invalid(reply: FastifyReply, fields: { field: string; message: string }[]) {
  return reply.code(400).send(failWithFields("invalid_field", "Check the highlighted fields.", fields));
}

function missing(reply: FastifyReply) {
  return reply.code(404).send(fail("not_found", "That import was not found."));
}

function routeId(params: unknown): string | null {
  if (!params || typeof params !== "object" || !("jobId" in params)) return null;
  const id = (params as { jobId?: unknown }).jobId;
  if (typeof id !== "string" || !uuid.test(id)) return null;
  return id.toLowerCase();
}
