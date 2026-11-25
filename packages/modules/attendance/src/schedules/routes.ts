import { fail, ok } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AttendanceCaller } from "./auth.ts";
import { ScheduleError } from "./errors.ts";
import {
  addHoliday,
  assignRosters,
  createDelegation,
  createLeaveRequest,
  createOvertimeRequest,
  createShift,
  decideLeave,
  decideOvertime,
  deleteShift,
  ensureAnnualBalance,
  listBalances,
  listDelegations,
  listHolidays,
  listLeaveRequests,
  listLeaveTypes,
  listOvertimeRequests,
  listRosters,
  listShifts,
  loadHolidayCalendar,
  lockPeriod,
  revokeDelegation,
  setBersamaDeduction,
  updateShift,
} from "./service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface AttendanceRouteDeps {
  appDb: TenantDatabase;
  adminGuard: preHandlerHookHandler;
  memberGuard: preHandlerHookHandler;
  readCaller(request: FastifyRequest): AttendanceCaller | null;
}

export async function registerAttendanceRoutes(
  app: FastifyInstance,
  deps: AttendanceRouteDeps,
): Promise<void> {
  app.get("/api/v1/shifts", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listShifts(deps.appDb, caller).then((rows) => ok(rows))),
  );
  app.post("/api/v1/shifts", { preHandler: deps.adminGuard }, async (request, reply) =>
    run(deps, request, reply, async (caller) => reply.code(201).send(ok(await createShift(deps.appDb, caller, request.body)))),
  );
  app.patch("/api/v1/shifts/:id", { preHandler: deps.adminGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply, "Shift not found.");
    return run(deps, request, reply, (caller) => updateShift(deps.appDb, caller, id, request.body).then((row) => ok(row)));
  });
  app.delete("/api/v1/shifts/:id", { preHandler: deps.adminGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply, "Shift not found.");
    return run(deps, request, reply, (caller) => deleteShift(deps.appDb, caller, id).then((row) => ok(row)));
  });

  app.get("/api/v1/rosters", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listRosters(deps.appDb, caller, request.query).then((rows) => ok(rows))),
  );
  app.post("/api/v1/rosters/bulk", { preHandler: deps.adminGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => assignRosters(deps.appDb, caller, request.body).then((row) => ok(row))),
  );

  app.get("/api/v1/holidays", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listHolidays(deps.appDb, caller, request.query).then((rows) => ok(rows))),
  );
  app.post("/api/v1/holidays", { preHandler: deps.adminGuard }, async (request, reply) =>
    run(deps, request, reply, async (caller) => reply.code(201).send(ok(await addHoliday(deps.appDb, caller, request.body)))),
  );
  app.post("/api/v1/holidays/load", { preHandler: deps.adminGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => loadHolidayCalendar(deps.appDb, caller, request.body).then((row) => ok(row))),
  );

  app.get("/api/v1/leave-types", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listLeaveTypes(deps.appDb, caller).then((rows) => ok(rows))),
  );
  app.patch("/api/v1/leave-types/:id", { preHandler: deps.adminGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply, "Leave type not found.");
    return run(deps, request, reply, (caller) =>
      setBersamaDeduction(deps.appDb, caller, id, request.body).then((row) => ok(row)),
    );
  });

  app.get("/api/v1/leave-balances", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listBalances(deps.appDb, caller, request.query).then((rows) => ok(rows))),
  );
  app.post("/api/v1/leave-balances/ensure", { preHandler: deps.adminGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => ensureAnnualBalance(deps.appDb, caller, request.body).then((row) => ok(row))),
  );

  app.get("/api/v1/leave-requests", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listLeaveRequests(deps.appDb, caller).then((rows) => ok(rows))),
  );
  app.post("/api/v1/leave-requests", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, async (caller) =>
      reply.code(201).send(ok(await createLeaveRequest(deps.appDb, caller, request.body))),
    ),
  );
  app.post("/api/v1/leave-requests/:id/decision", { preHandler: deps.memberGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply, "Leave request not found.");
    return run(deps, request, reply, (caller) => decideLeave(deps.appDb, caller, id, request.body).then((row) => ok(row)));
  });

  app.get("/api/v1/overtime-requests", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listOvertimeRequests(deps.appDb, caller).then((rows) => ok(rows))),
  );
  app.post("/api/v1/overtime-requests", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, async (caller) =>
      reply.code(201).send(ok(await createOvertimeRequest(deps.appDb, caller, request.body))),
    ),
  );
  app.post("/api/v1/overtime-requests/:id/decision", { preHandler: deps.memberGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply, "Overtime request not found.");
    return run(deps, request, reply, (caller) =>
      decideOvertime(deps.appDb, caller, id, request.body).then((row) => ok(row)),
    );
  });

  app.get("/api/v1/attendance/delegations", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, (caller) => listDelegations(deps.appDb, caller).then((rows) => ok(rows))),
  );
  app.post("/api/v1/attendance/delegations", { preHandler: deps.memberGuard }, async (request, reply) =>
    run(deps, request, reply, async (caller) =>
      reply.code(201).send(ok(await createDelegation(deps.appDb, caller, request.body))),
    ),
  );
  app.post("/api/v1/attendance/delegations/:id/revoke", { preHandler: deps.memberGuard }, async (request, reply) => {
    const id = routeId(request);
    if (!id) return missing(reply, "Delegation not found.");
    return run(deps, request, reply, (caller) => revokeDelegation(deps.appDb, caller, id).then((row) => ok(row)));
  });

  app.post("/api/v1/attendance/periods/:yearMonth/lock", { preHandler: deps.adminGuard }, async (request, reply) => {
    const yearMonth = (request.params as { yearMonth?: unknown }).yearMonth;
    if (typeof yearMonth !== "string") return missing(reply, "Period not found.");
    return run(deps, request, reply, (caller) => lockPeriod(deps.appDb, caller, yearMonth).then((row) => ok(row)));
  });
}

async function run(
  deps: AttendanceRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (caller: AttendanceCaller) => Promise<unknown>,
): Promise<unknown> {
  const caller = deps.readCaller(request);
  if (!caller) return reply.code(401).send(fail("unauthenticated", "Sign in required."));
  try {
    return await fn(caller);
  } catch (error) {
    if (error instanceof ScheduleError) return reply.code(error.status).send(fail(error.code, error.message));
    request.log.error({ msg: "attendance request failed" });
    return reply.code(500).send(fail("internal_error", "Request failed."));
  }
}

function routeId(request: FastifyRequest): string | null {
  const params = request.params as { id?: unknown };
  return typeof params.id === "string" && UUID.test(params.id) ? params.id : null;
}

function missing(reply: FastifyReply, message: string) {
  return reply.code(404).send(fail("not_found", message));
}
