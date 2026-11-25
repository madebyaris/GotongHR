import { fail, failWithFields, ok, type PermissionAtom } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { ObjectStorage } from "@gotonghr/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { CoreHrAuth } from "../auth.ts";
import { EmployeeConflictError, EmployeeFieldError, EmployeeForbiddenError, EmployeeNotFoundError } from "../errors.ts";
import { confirmDocument, createDocumentDownload, createDocumentUpload, DocumentNotFoundError, listDocuments } from "./service.ts";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface EmployeeDocumentRouteDeps {
  appDb: TenantDatabase;
  storage: ObjectStorage;
  guard: (permission: PermissionAtom) => preHandlerHookHandler;
  readAuth: (request: FastifyRequest) => CoreHrAuth | null;
}

export async function registerEmployeeDocuments(
  app: FastifyInstance,
  deps: EmployeeDocumentRouteDeps,
): Promise<void> {
  app.post(
    "/api/v1/employees/:id/documents/upload-url",
    { preHandler: deps.guard("employee.write") },
    async (request, reply) => {
      const id = routeId(request.params, "id");
      if (!id) return missingEmployee(reply);
      return run(deps, request, reply, (auth) =>
        createDocumentUpload(deps.appDb, deps.storage, auth, id, request.body as Record<string, unknown>).then((upload) =>
          reply.code(200).send(ok(upload)),
        ),
      );
    },
  );

  app.post(
    "/api/v1/employees/:id/documents",
    { preHandler: deps.guard("employee.write") },
    async (request, reply) => {
      const id = routeId(request.params, "id");
      if (!id) return missingEmployee(reply);
      return run(deps, request, reply, (auth) =>
        confirmDocument(deps.appDb, deps.storage, auth, id, request.body as Record<string, unknown>).then((row) =>
          reply.code(201).send(ok(row)),
        ),
      );
    },
  );

  app.get(
    "/api/v1/employees/:id/documents",
    { preHandler: deps.guard("employee.read") },
    async (request, reply) => {
      const id = routeId(request.params, "id");
      if (!id) return missingEmployee(reply);
      const page = parsePage(request.query);
      if (!page.ok) return invalid(reply, page.fields);
      return run(deps, request, reply, (auth) =>
        listDocuments(deps.appDb, auth, id, page.value).then((rows) => ok(rows, page.value)),
      );
    },
  );

  app.get(
    "/api/v1/employees/:id/documents/:documentId/download-url",
    { preHandler: deps.guard("employee.read") },
    async (request, reply) => {
      const id = routeId(request.params, "id");
      const documentId = routeId(request.params, "documentId");
      if (!id) return missingEmployee(reply);
      if (!documentId) return missingDocument(reply);
      return run(deps, request, reply, (auth) =>
        createDocumentDownload(deps.appDb, deps.storage, auth, id, documentId).then((download) => ok(download)),
      );
    },
  );
}

async function run(
  deps: EmployeeDocumentRouteDeps,
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
    if (error instanceof EmployeeNotFoundError) return missingEmployee(reply);
    if (error instanceof DocumentNotFoundError) return missingDocument(reply);
    if (error instanceof EmployeeConflictError) {
      return reply.code(409).send(failWithFields("conflict", error.message, error.fields));
    }
    if (error instanceof EmployeeForbiddenError) {
      return reply.code(403).send(fail("forbidden", error.message));
    }
    request.log.error({ err: error }, "document request failed");
    return reply.code(500).send(fail("internal_error", "Request failed."));
  }
}

function invalid(reply: FastifyReply, fields: { field: string; message: string }[]) {
  return reply.code(400).send(failWithFields("invalid_field", "Check the highlighted fields.", fields));
}

function missingEmployee(reply: FastifyReply) {
  return reply.code(404).send(fail("not_found", "That employee was not found."));
}

function missingDocument(reply: FastifyReply) {
  return reply.code(404).send(fail("not_found", "That document was not found."));
}

function routeId(params: unknown, key: string): string | null {
  if (!params || typeof params !== "object" || !(key in params)) return null;
  const id = (params as Record<string, unknown>)[key];
  if (typeof id !== "string" || !uuid.test(id)) return null;
  return id.toLowerCase();
}

function parsePage(query: unknown):
  | { ok: true; value: { limit: number; offset: number } }
  | { ok: false; fields: { field: string; message: string }[] } {
  const record = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const fields: { field: string; message: string }[] = [];
  const limit = parseBound(record.limit, 25, 1, 100, "Use a limit from 1 to 100.");
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
