import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { migrateAudit } from "@gotonghr/audit";
import { canWriteOrg, fail } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { sql } from "drizzle-orm";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type LightMyRequestResponse,
} from "fastify";
import pg from "pg";
import type { AttendanceCaller } from "./auth.ts";
import { migrateAttendance } from "./migrate.ts";
import { registerAttendanceRoutes } from "./routes.ts";

const { Client } = pg;

loadRepoEnv();
applyDatabaseUrls(process.env);
process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";

interface SummaryRow {
  work_date: string;
  is_locked: boolean;
  locked_at: Date | string | null;
  locked_for_payroll_run_id: string | null;
  approved_overtime_minutes: number;
}

describe("shifts, leave, and overtime", { concurrency: 1 }, () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const hrA = randomUUID();
  const hrB = randomUUID();
  const lineA = randomUUID();
  const branchA = randomUUID();
  const employeeA = randomUUID();
  const actors = new Map<string, AttendanceCaller>([
    ["a:hr", caller(tenantA, hrA, "hr_admin", ["attendance.approve"])],
    ["b:hr", caller(tenantB, hrB, "hr_admin", ["attendance.approve"])],
    ["a:line", caller(tenantA, lineA, "line_manager", ["attendance.approve"])],
    ["a:branch", caller(tenantA, branchA, "branch_manager", ["attendance.approve"])],
    ["a:employee", caller(tenantA, employeeA, "employee", [])],
  ]);
  let app: FastifyInstance | undefined;
  let appDb: TenantDatabase | undefined;
  let platform: pg.Client | undefined;
  let superuser: pg.Client | undefined;

  before(async () => {
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateAudit({ migratorUrl: migrateEnv.migratorUrl });
    await migrateAttendance({ migratorUrl: migrateEnv.migratorUrl });
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
    app = Fastify({ logger: false });
    await registerAttendanceRoutes(app, {
      appDb,
      adminGuard: guard(actors, "admin"),
      memberGuard: guard(actors, "member"),
      readCaller(request) {
        const name = request.headers["x-test-actor"];
        return typeof name === "string" ? actors.get(name) ?? null : null;
      },
    });
  });

  after(async () => {
    const tenants = [tenantA, tenantB];
    if (superuser) {
      for (const table of [
        "att_rosters",
        "att_leave_requests",
        "att_leave_balances",
        "att_overtime_requests",
        "att_daily_summaries",
        "att_holidays",
        "att_approval_delegations",
        "att_leave_types",
        "att_shifts",
        "aud_events",
        "aud_tenant_keys",
      ]) {
        await superuser.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]).catch(() => undefined);
      }
    }
    await app?.close();
    await appDb?.end();
    await platform?.end();
    await superuser?.end();
  });

  it("isolates tenants, denies platform_admin, and keeps shift writes on the audit chain", async () => {
    const denied = await send(app, "POST", "a:employee", "/api/v1/shifts", shiftBody("PAGI"));
    assert.equal(denied.statusCode, 403, denied.body);
    const created = await send(app, "POST", "a:hr", "/api/v1/shifts", shiftBody("PAGI"));
    const shift = readData<{ id: string; code: string; startLocalTime: string }>(created, 201);
    assert.equal(shift.code, "PAGI");
    assert.equal(shift.startLocalTime, "08:00");
    assert.equal(shift.id.split("-")[2]?.[0], "7");
    const patched = await send(app, "PATCH", "a:hr", `/api/v1/shifts/${shift.id}`, shiftBody("SIANG", "Siang"));
    assert.equal(readData<{ code: string }>(patched, 200).code, "SIANG");
    const other = await send(app, "GET", "b:hr", "/api/v1/shifts");
    assert.deepEqual(readData<unknown[]>(other, 200), []);
    const hidden = await send(app, "PATCH", "b:hr", `/api/v1/shifts/${shift.id}`, shiftBody("MALAM"));
    assert.equal(hidden.statusCode, 404, hidden.body);
    const employeeId = randomUUID();
    const assigned = await send(app, "POST", "a:hr", "/api/v1/rosters/bulk", {
      assignments: [{ employeeId, shiftId: shift.id, workDate: "2026-01-05" }],
    });
    assert.equal(readData<{ count: number }>(assigned, 200).count, 1);
    const roster = await send(app, "GET", "a:hr", "/api/v1/rosters?from=2026-01-01&to=2026-01-31");
    assert.equal(readData<unknown[]>(roster, 200).length, 1);
    const rosterB = await send(app, "GET", "b:hr", "/api/v1/rosters?from=2026-01-01&to=2026-01-31");
    assert.deepEqual(readData<unknown[]>(rosterB, 200), []);

    if (!appDb || !platform || !superuser) throw new Error("setup did not start");
    await appDb.withTenantContext(tenantB, async (tx) => {
      const visible = rowsOf(await tx.execute(sql`SELECT id::text AS id FROM att_shifts`));
      assert.equal(visible.length, 0);
    });
    const bare = await appDb.pool.query("SELECT id FROM att_shifts");
    assert.equal(bare.rows.length, 0);
    await assert.rejects(platform.query("SELECT id FROM att_shifts"), isDenied);
    await assert.rejects(platform.query("SELECT id FROM att_leave_requests"), isDenied);
    const audit = await superuser.query<{ action: string }>(
      "SELECT action FROM aud_events WHERE tenant_id = $1 AND resource_id = $2 ORDER BY created_at",
      [tenantA, shift.id],
    );
    assert.equal(audit.rows.some((row) => row.action === "shift.create"), true);
    assert.equal(audit.rows.some((row) => row.action === "shift.update"), true);
  });

  it("stores the day type a 5-day week and att_holidays imply", async () => {
    const loaded = await send(app, "POST", "a:hr", "/api/v1/holidays/load", { year: 2026 });
    const calendar = readData<{ status: string; loaded: number; year: number }>(loaded, 200);
    assert.equal(calendar.status, "draft");
    assert.equal(calendar.year, 2026);
    assert.equal(calendar.loaded > 0, true);
    const listed = readData<Array<{ date: string; sourceStatus: string }>>(
      await send(app, "GET", "a:hr", "/api/v1/holidays?year=2026"),
      200,
    );
    assert.equal(listed.every((row) => row.sourceStatus === "draft"), true);
    assert.equal(listed.some((row) => row.date === "2026-01-01"), true);
    const otherTenant = readData<unknown[]>(await send(app, "GET", "b:hr", "/api/v1/holidays?year=2026"), 200);
    assert.deepEqual(otherTenant, []);
    await send(app, "POST", "a:hr", "/api/v1/holidays", {
      date: "2026-01-10",
      name: "Sabtu libur uji",
      kind: "national",
    });

    const employeeId = randomUUID();
    const cases: Array<{ date: string; week: "5_day" | "6_day"; dayType: string }> = [
      { date: "2026-01-02", week: "5_day", dayType: "workday" },
      { date: "2026-01-03", week: "5_day", dayType: "weekend" },
      { date: "2026-01-01", week: "5_day", dayType: "national_holiday" },
      { date: "2026-01-10", week: "5_day", dayType: "national_holiday" },
      { date: "2026-01-03", week: "6_day", dayType: "workday" },
      { date: "2026-01-04", week: "6_day", dayType: "weekend" },
    ];
    for (const item of cases) {
      const response = await send(app, "POST", "a:employee", "/api/v1/overtime-requests", {
        employeeId,
        workDate: item.date,
        startsAt: `${item.date}T01:00:00.000Z`,
        endsAt: `${item.date}T02:00:00.000Z`,
        workweekType: item.week,
        dayType: "workday",
      });
      const saved = readData<{ dayType: string; requestedMinutes: number }>(response, 201);
      assert.equal(saved.dayType, item.dayType, item.date);
      assert.equal(saved.requestedMinutes, 60);
    }
  });

  it("follows the approval chain, honors a delegation row, and rejects a second decision", async () => {
    const employeeId = randomUUID();
    const created = await send(app, "POST", "a:employee", "/api/v1/overtime-requests", {
      employeeId,
      workDate: "2026-02-02",
      startsAt: "2026-02-02T01:00:00.000Z",
      endsAt: "2026-02-02T03:00:00.000Z",
      workweekType: "5_day",
    });
    const request = readData<{ id: string; dayType: string; requestedMinutes: number }>(created, 201);
    assert.equal(request.dayType, "workday");
    assert.equal(request.requestedMinutes, 120);
    const early = await send(app, "POST", "a:branch", `/api/v1/overtime-requests/${request.id}/decision`, {
      decision: "approve",
    });
    assert.equal(early.statusCode, 403, early.body);
    const lined = await send(app, "POST", "a:line", `/api/v1/overtime-requests/${request.id}/decision`, {
      decision: "approve",
    });
    assert.equal(readData<{ status: string }>(lined, 200).status, "pending_final");
    const blocked = await send(app, "POST", "a:employee", `/api/v1/overtime-requests/${request.id}/decision`, {
      decision: "approve",
    });
    assert.equal(blocked.statusCode, 403, blocked.body);
    const expired = await send(app, "POST", "a:hr", "/api/v1/attendance/delegations", {
      delegatorUserId: branchA,
      delegateUserId: employeeA,
      roleCode: "branch_manager",
      startsAt: "2020-01-01T00:00:00.000Z",
      endsAt: "2020-01-02T00:00:00.000Z",
    });
    assert.equal(expired.statusCode, 201, expired.body);
    const stillBlocked = await send(app, "POST", "a:employee", `/api/v1/overtime-requests/${request.id}/decision`, {
      decision: "approve",
      approvedMinutes: 30,
    });
    assert.equal(stillBlocked.statusCode, 403, stillBlocked.body);
    const delegation = await send(app, "POST", "a:hr", "/api/v1/attendance/delegations", {
      delegatorUserId: branchA,
      delegateUserId: employeeA,
      roleCode: "branch_manager",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(delegation.statusCode, 201, delegation.body);
    const approved = await send(app, "POST", "a:employee", `/api/v1/overtime-requests/${request.id}/decision`, {
      decision: "approve",
      approvedMinutes: 30,
    });
    const final = readData<{ status: string; approvedMinutes: number | null }>(approved, 200);
    assert.equal(final.status, "approved");
    assert.equal(final.approvedMinutes, 30);
    const again = await send(app, "POST", "a:hr", `/api/v1/overtime-requests/${request.id}/decision`, {
      decision: "reject",
    });
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(readCode(again), "already_decided");

    const rejected = await send(app, "POST", "a:employee", "/api/v1/overtime-requests", {
      employeeId,
      workDate: "2026-02-03",
      startsAt: "2026-02-03T01:00:00.000Z",
      endsAt: "2026-02-03T02:00:00.000Z",
      workweekType: "5_day",
    });
    const second = readData<{ id: string }>(rejected, 201);
    const firstNo = await send(app, "POST", "a:line", `/api/v1/overtime-requests/${second.id}/decision`, {
      decision: "reject",
      reason: "Tidak perlu",
    });
    assert.equal(readData<{ status: string }>(firstNo, 200).status, "rejected");
    const secondNo = await send(app, "POST", "a:line", `/api/v1/overtime-requests/${second.id}/decision`, {
      decision: "approve",
    });
    assert.equal(secondNo.statusCode, 409, secondNo.body);
    assert.equal(readCode(secondNo), "already_decided");
  });

  it("locks the period into daily summaries and rejects a later approval", async () => {
    const employeeId = randomUUID();
    const created = await send(app, "POST", "a:employee", "/api/v1/overtime-requests", {
      employeeId,
      workDate: "2026-04-06",
      startsAt: "2026-04-06T01:00:00.000Z",
      endsAt: "2026-04-06T02:00:00.000Z",
      workweekType: "5_day",
    });
    const request = readData<{ id: string }>(created, 201);
    const locked = await send(app, "POST", "a:hr", "/api/v1/attendance/periods/2026-04/lock");
    const result = readData<{ yearMonth: string; employeeCount: number; summaryCount: number }>(locked, 200);
    assert.equal(result.yearMonth, "2026-04");
    assert.equal(result.employeeCount >= 1, true);
    assert.equal(result.summaryCount, result.employeeCount * 30);
    if (!appDb) throw new Error("setup did not start");
    const summaries = await appDb.withTenantContext(tenantA, async (tx) =>
      rowsOf<SummaryRow>(await tx.execute(sql`
        SELECT work_date::text AS work_date, is_locked, locked_at,
               locked_for_payroll_run_id::text AS locked_for_payroll_run_id,
               approved_overtime_minutes
        FROM att_daily_summaries
        WHERE employee_id = ${employeeId}::uuid
          AND work_date >= '2026-04-01'::date
          AND work_date <= '2026-04-30'::date
      `)),
    );
    assert.equal(summaries.length, 30);
    assert.equal(summaries.every((row) => row.is_locked === true), true);
    assert.equal(summaries.every((row) => row.locked_at !== null), true);
    assert.equal(summaries.every((row) => row.locked_for_payroll_run_id === null), true);
    assert.equal(summaries.every((row) => Number(row.approved_overtime_minutes) === 0), true);
    const decision = await send(app, "POST", "a:line", `/api/v1/overtime-requests/${request.id}/decision`, {
      decision: "approve",
    });
    assert.equal(decision.statusCode, 409, decision.body);
    assert.equal(readCode(decision), "period_locked");
    const later = await send(app, "POST", "a:employee", "/api/v1/overtime-requests", {
      employeeId: randomUUID(),
      workDate: "2026-04-08",
      startsAt: "2026-04-08T01:00:00.000Z",
      endsAt: "2026-04-08T02:00:00.000Z",
      workweekType: "5_day",
    });
    const laterId = readData<{ id: string }>(later, 201).id;
    const laterDecision = await send(app, "POST", "a:line", `/api/v1/overtime-requests/${laterId}/decision`, {
      decision: "approve",
    });
    assert.equal(laterDecision.statusCode, 409, laterDecision.body);
    assert.equal(readCode(laterDecision), "period_locked");
  });

  it("deducts Cuti Tahunan for Cuti Bersama until the tenant turns the toggle off", async () => {
    const types = readData<Array<{ id: string; code: string; deductsAnnual: boolean; entitlementDays: number | null }>>(
      await send(app, "GET", "a:hr", "/api/v1/leave-types"),
      200,
    );
    const bersama = types.find((type) => type.code === "cuti_bersama");
    const tahunan = types.find((type) => type.code === "cuti_tahunan");
    assert.ok(bersama);
    assert.equal(bersama.deductsAnnual, true);
    assert.equal(tahunan?.entitlementDays, 12);
    const employeeId = randomUUID();
    const balance = readData<{ entitledDays: number; usedDays: number }>(
      await send(app, "POST", "a:hr", "/api/v1/leave-balances/ensure", {
        employeeId,
        joinedOn: "2024-01-01",
        asOf: "2026-06-01",
      }),
      200,
    );
    assert.equal(balance.entitledDays, 12);
    assert.equal(balance.usedDays, 0);
    await approveLeave(app, employeeId, "2026-06-01", "2026-06-02");
    const used = await annualUsed(app, employeeId);
    assert.equal(used, 2);
    const toggled = await send(app, "PATCH", "a:hr", `/api/v1/leave-types/${bersama.id}`, { deductsAnnual: false });
    assert.equal(readData<{ deductsAnnual: boolean }>(toggled, 200).deductsAnnual, false);
    await approveLeave(app, employeeId, "2026-06-08", "2026-06-09");
    assert.equal(await annualUsed(app, employeeId), 2);
    const other = readData<unknown[]>(
      await send(app, "GET", "b:hr", `/api/v1/leave-balances?employeeId=${employeeId}`),
      200,
    );
    assert.deepEqual(other, []);
  });
});

async function approveLeave(
  app: FastifyInstance | undefined,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  const created = await send(app, "POST", "a:employee", "/api/v1/leave-requests", {
    employeeId,
    leaveTypeCode: "cuti_bersama",
    startDate,
    endDate,
  });
  const id = readData<{ id: string; dayCount: number }>(created, 201);
  assert.equal(id.dayCount, 2);
  const lined = await send(app, "POST", "a:line", `/api/v1/leave-requests/${id.id}/decision`, { decision: "approve" });
  assert.equal(readData<{ status: string }>(lined, 200).status, "pending_final");
  const approved = await send(app, "POST", "a:hr", `/api/v1/leave-requests/${id.id}/decision`, { decision: "approve" });
  assert.equal(readData<{ status: string }>(approved, 200).status, "approved");
}

async function annualUsed(app: FastifyInstance | undefined, employeeId: string): Promise<number> {
  const rows = readData<Array<{ leaveTypeCode: string; usedDays: number }>>(
    await send(app, "GET", "a:hr", `/api/v1/leave-balances?employeeId=${employeeId}`),
    200,
  );
  const annual = rows.find((row) => row.leaveTypeCode === "cuti_tahunan");
  assert.ok(annual);
  return Number(annual.usedDays);
}

function caller(tenantId: string, userId: string, role: string, permissions: readonly string[]): AttendanceCaller {
  return { tenantId, userId, role, permissions, ipAddress: "127.0.0.1", userAgent: "attendance-test" };
}

function guard(actors: Map<string, AttendanceCaller>, kind: "admin" | "member") {
  return async function attendanceGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const name = request.headers["x-test-actor"];
    const actor = typeof name === "string" ? actors.get(name) : undefined;
    if (!actor) {
      await reply.code(401).send(fail("unauthenticated", "Sign in required."));
      return;
    }
    if (kind === "admin" && !canWriteOrg(actor.role)) {
      await reply.code(403).send(fail("forbidden", "Only an owner or HR admin can change the company."));
      return;
    }
  };
}

function shiftBody(code: string, name = "Pagi"): Record<string, unknown> {
  return {
    code,
    name,
    startLocalTime: "08:00",
    endLocalTime: "17:00",
    graceMinutes: 10,
    workweekType: "5_day",
    isOvernight: false,
  };
}

function send(
  app: FastifyInstance | undefined,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  actor: string,
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  if (!app) return Promise.reject(new Error("server did not start"));
  return app.inject({
    method,
    url,
    headers: { "x-test-actor": actor, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function readData<T>(response: { statusCode: number; body: string }, status: number): T {
  assert.equal(response.statusCode, status, response.body);
  return (JSON.parse(response.body) as { data: T }).data;
}

function readCode(response: { body: string }): string | undefined {
  return (JSON.parse(response.body) as { error: { code?: string } | null }).error?.code;
}

function rowsOf<T = { id: string }>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  if (Array.isArray(result)) return result as T[];
  return [];
}

function isDenied(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if ("code" in current && current.code === "42501") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
