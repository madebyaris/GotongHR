import { fail, failWithFields, ok } from "@gotonghr/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { PayrollCaller } from "./caller.ts";
import { PayrollError } from "./errors.ts";
import {
  approveRun,
  calculateRun,
  createRun,
  exportBank,
  exportCoretax,
  finalizeRun,
  getRun,
  payslipDownloadUrl,
  preflightRun,
  type PayrollDeps,
} from "./service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface PayrollRouteDeps extends PayrollDeps {
  prepareGuard: preHandlerHookHandler;
  createGuard: preHandlerHookHandler;
  finalizeGuard: preHandlerHookHandler;
  exportGuard: preHandlerHookHandler;
  memberGuard: preHandlerHookHandler;
  readCaller(request: FastifyRequest): PayrollCaller | null;
}

export async function registerPayrollRoutes(app: FastifyInstance, deps: PayrollRouteDeps): Promise<void> {
  app.post("/api/v1/payroll/runs", { preHandler: deps.createGuard }, async (request, reply) =>
    run(deps, request, reply, async (caller) => reply.code(201).send(ok(await createRun(deps, caller, request.body)))),
  );
  app.get("/api/v1/payroll/runs/:id", { preHandler: deps.prepareGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, (caller) => getRun(deps, caller, id).then((row) => ok(row)));
  });
  app.post("/api/v1/payroll/runs/:id/preflight", { preHandler: deps.prepareGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, (caller) => preflightRun(deps, caller, id).then((row) => ok(row)));
  });
  app.post("/api/v1/payroll/runs/:id/calculate", { preHandler: deps.prepareGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, (caller) => calculateRun(deps, caller, id).then((row) => ok(row)));
  });
  app.post("/api/v1/payroll/runs/:id/approve", { preHandler: deps.prepareGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, (caller) => approveRun(deps, caller, id).then((row) => ok(row)));
  });
  app.post("/api/v1/payroll/runs/:id/finalize", { preHandler: deps.finalizeGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, (caller) => finalizeRun(deps, caller, id).then((row) => ok(row)));
  });
  app.post("/api/v1/payroll/runs/:id/exports/coretax", { preHandler: deps.exportGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, async (caller) => reply.code(201).send(ok(await exportCoretax(deps, caller, id))));
  });
  app.post("/api/v1/payroll/runs/:id/exports/bank-batch", { preHandler: deps.exportGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, async (caller) =>
      reply.code(201).send(ok(await exportBank(deps, caller, id, request.body))),
    );
  });
  app.get("/api/v1/mobile/payslips/:id/download-url", { preHandler: deps.memberGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply);
    return run(deps, request, reply, (caller) => payslipDownloadUrl(deps, caller, id).then((row) => ok(row)));
  });
}

function routeId(request: FastifyRequest): string | null {
  const id = (request.params as { id?: unknown }).id;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

function missing(reply: FastifyReply): FastifyReply {
  return reply.code(404).send(fail("not_found", "Payroll run was not found."));
}

async function run(
  deps: PayrollRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  action: (caller: PayrollCaller) => Promise<unknown>,
): Promise<unknown> {
  const caller = deps.readCaller(request);
  if (!caller) return reply.code(401).send(fail("unauthenticated", "Sign in required."));
  try {
    return await action(caller);
  } catch (error) {
    if (error instanceof PayrollError) {
      const body =
        error.fields.length > 0 ? failWithFields(error.code, error.message, error.fields) : fail(error.code, error.message);
      return reply.code(error.status).send(body);
    }
    throw error;
  }
}
