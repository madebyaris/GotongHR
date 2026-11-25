import { appendAuditEvent, provisionTenantKeys } from "@gotonghr/audit";
import { canWriteOrg } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import type { AttendanceCaller } from "./auth.ts";
import {
  annualEntitlement,
  defaultLeaveTypes,
  deriveDayType,
  inclusiveDays,
  isApprovalRole,
  isIsoDate,
  isWorkweekType,
  monthBounds,
  readHolidayFile,
  type ApprovalRole,
  type DayType,
  type WorkweekType,
} from "./calendar.ts";
import { invalid, ScheduleError } from "./errors.ts";
import { asObject, asRecord, clip, errorCode, queryRows } from "./sql.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/u;

export interface ShiftView {
  id: string;
  code: string;
  name: string;
  startLocalTime: string;
  endLocalTime: string;
  graceMinutes: number;
  workweekType: WorkweekType;
  isOvernight: boolean;
}

export interface RosterView {
  id: string;
  employeeId: string;
  shiftId: string;
  workDate: string;
}

export interface HolidayView {
  id: string;
  date: string;
  name: string;
  kind: "national" | "joint";
  sourceStatus: string;
  calendarYear: number;
}

export interface LeaveTypeView {
  id: string;
  code: string;
  name: string;
  tenureMonths: number | null;
  entitlementDays: number | null;
  deductsAnnual: boolean;
  deductionToggle: boolean;
}

export interface BalanceView {
  id: string;
  employeeId: string;
  leaveTypeCode: string;
  balanceYear: number;
  entitledDays: number;
  usedDays: number;
}

export interface LeaveRequestView {
  id: string;
  employeeId: string;
  leaveTypeCode: string;
  startDate: string;
  endDate: string;
  dayCount: number;
  status: string;
  decisionReason: string | null;
}

export interface OvertimeRequestView {
  id: string;
  employeeId: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  workweekType: WorkweekType;
  dayType: DayType;
  requestedMinutes: number;
  approvedMinutes: number | null;
  status: string;
  decisionReason: string | null;
}

export interface DelegationView {
  id: string;
  delegatorUserId: string;
  delegateUserId: string;
  roleCode: ApprovalRole;
  startsAt: string;
  endsAt: string;
  revokedAt: string | null;
}

export interface LockResult {
  yearMonth: string;
  employeeCount: number;
  summaryCount: number;
}

interface DecisionInput {
  decision: "approve" | "reject";
  reason: string | null;
  approvedMinutes: number | null;
}

interface ShiftRow {
  id: string;
  code: string;
  name: string;
  start_local_time: string;
  end_local_time: string;
  grace_minutes: number;
  workweek_type: string;
  is_overnight: boolean;
  before_json?: unknown;
  after_json?: unknown;
}

export async function listShifts(appDb: TenantDatabase, caller: AttendanceCaller): Promise<ShiftView[]> {
  const tenantId = tenantOf(caller);
  return appDb.withTenantContext(tenantId, async (tx) => {
    const rows = queryRows<ShiftRow>(await tx.execute(sql`
      SELECT id::text AS id, code, name, start_local_time::text AS start_local_time,
             end_local_time::text AS end_local_time, grace_minutes, workweek_type, is_overnight
      FROM att_shifts
      ORDER BY code
    `));
    return rows.map(shiftView);
  });
}

export async function createShift(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<ShiftView> {
  assertWriter(caller);
  const input = parseShift(body);
  return write(appDb, caller, async (tx) => {
    const rows = queryRows<ShiftRow>(await tx.execute(sql`
      INSERT INTO att_shifts (
        tenant_id, code, name, start_local_time, end_local_time, grace_minutes, workweek_type, is_overnight
      ) VALUES (
        ${caller.tenantId}::uuid,
        ${input.code},
        ${input.name},
        ${input.startLocalTime}::time,
        ${input.endLocalTime}::time,
        ${input.graceMinutes},
        ${input.workweekType},
        ${input.isOvernight}
      )
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, code, name, start_local_time::text AS start_local_time,
        end_local_time::text AS end_local_time, grace_minutes, workweek_type, is_overnight,
        to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = requiredRow(rows[0], "shift insert returned no row");
    await audit(tx, caller, "shift.create", "att_shifts", row.id, row.before_json, row.after_json);
    return shiftView(row);
  });
}

export async function updateShift(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  id: string,
  body: unknown,
): Promise<ShiftView> {
  assertWriter(caller);
  const shiftId = assertUuid(id, "id");
  const input = parseShift(body);
  return write(appDb, caller, async (tx) => {
    const rows = queryRows<ShiftRow>(await tx.execute(sql`
      UPDATE att_shifts SET
        code = ${input.code},
        name = ${input.name},
        start_local_time = ${input.startLocalTime}::time,
        end_local_time = ${input.endLocalTime}::time,
        grace_minutes = ${input.graceMinutes},
        workweek_type = ${input.workweekType},
        is_overnight = ${input.isOvernight},
        updated_at = now()
      WHERE id = ${shiftId}::uuid
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, code, name, start_local_time::text AS start_local_time,
        end_local_time::text AS end_local_time, grace_minutes, workweek_type, is_overnight,
        to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = rows[0];
    if (!row) throw new ScheduleError(404, "not_found", "Shift not found.");
    await audit(tx, caller, "shift.update", "att_shifts", row.id, row.before_json, row.after_json);
    return shiftView(row);
  });
}

export async function deleteShift(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  id: string,
): Promise<{ id: string }> {
  assertWriter(caller);
  const shiftId = assertUuid(id, "id");
  return write(appDb, caller, async (tx) => {
    const rows = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      DELETE FROM att_shifts WHERE id = ${shiftId}::uuid
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = rows[0];
    if (!row) throw new ScheduleError(404, "not_found", "Shift not found.");
    await audit(tx, caller, "shift.delete", "att_shifts", row.id, row.before_json, row.after_json);
    return { id: row.id };
  });
}

export async function listRosters(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  query: unknown,
): Promise<RosterView[]> {
  const tenantId = tenantOf(caller);
  const range = parseRange(query);
  return appDb.withTenantContext(tenantId, async (tx) => {
    const rows = queryRows<RosterView>(await tx.execute(sql`
      SELECT id::text AS id, employee_id::text AS "employeeId", shift_id::text AS "shiftId",
             work_date::text AS "workDate"
      FROM att_rosters
      WHERE work_date >= ${range.from}::date
        AND work_date <= ${range.to}::date
        AND (${range.employeeId}::uuid IS NULL OR employee_id = ${range.employeeId}::uuid)
      ORDER BY work_date, employee_id
    `));
    return rows;
  });
}

export async function assignRosters(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<{ count: number }> {
  assertWriter(caller);
  const assignments = parseAssignments(body);
  return write(appDb, caller, async (tx) => {
    for (const assignment of assignments) {
      const shift = queryRows<{ id: string }>(await tx.execute(sql`
        SELECT id::text AS id FROM att_shifts WHERE id = ${assignment.shiftId}::uuid
      `));
      if (!shift[0]) throw new ScheduleError(400, "invalid_field", "shiftId does not match a shift.");
      const rows = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
        INSERT INTO att_rosters (tenant_id, employee_id, shift_id, work_date)
        VALUES (
          ${caller.tenantId}::uuid,
          ${assignment.employeeId}::uuid,
          ${assignment.shiftId}::uuid,
          ${assignment.workDate}::date
        )
        ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET
          shift_id = EXCLUDED.shift_id,
          updated_at = now()
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
      `));
      const row = requiredRow(rows[0], "roster insert returned no row");
      await audit(tx, caller, "roster.assign", "att_rosters", row.id, row.before_json, row.after_json);
    }
    return { count: assignments.length };
  });
}

export async function listHolidays(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  query: unknown,
): Promise<HolidayView[]> {
  const tenantId = tenantOf(caller);
  const year = parseYear(query);
  return appDb.withTenantContext(tenantId, async (tx) => {
    const rows = queryRows<HolidayView>(await tx.execute(sql`
      SELECT id::text AS id, holiday_date::text AS date, name, kind,
             source_status AS "sourceStatus", calendar_year AS "calendarYear"
      FROM att_holidays
      WHERE (${year}::int IS NULL OR calendar_year = ${year})
      ORDER BY holiday_date
    `));
    return rows;
  });
}

export async function loadHolidayCalendar(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<{ year: number; status: string; loaded: number }> {
  assertWriter(caller);
  const record = asRecord(body);
  const file = readHolidayFile();
  const year = record && typeof record.year === "number" ? record.year : file.year;
  if (year !== file.year) {
    throw new ScheduleError(400, "calendar_unavailable", "Only the shipped draft calendar can be loaded.");
  }
  return write(appDb, caller, async (tx) => {
    let loaded = 0;
    for (const holiday of file.holidays) {
      const rows = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
        INSERT INTO att_holidays (tenant_id, holiday_date, name, kind, source_status, calendar_year)
        VALUES (
          ${caller.tenantId}::uuid,
          ${holiday.date}::date,
          ${holiday.name},
          ${holiday.kind},
          ${file.status},
          ${file.year}
        )
        ON CONFLICT (tenant_id, holiday_date) DO UPDATE SET
          name = EXCLUDED.name,
          kind = EXCLUDED.kind,
          source_status = EXCLUDED.source_status,
          calendar_year = EXCLUDED.calendar_year,
          updated_at = now()
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
      `));
      const row = requiredRow(rows[0], "holiday load returned no row");
      await audit(tx, caller, "holiday.load", "att_holidays", row.id, row.before_json, row.after_json);
      loaded += 1;
    }
    return { year: file.year, status: file.status, loaded };
  });
}

export async function addHoliday(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<HolidayView> {
  assertWriter(caller);
  const input = parseHoliday(body);
  return write(appDb, caller, async (tx) => {
    const rows = queryRows<HolidayView & { before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      INSERT INTO att_holidays (tenant_id, holiday_date, name, kind, source_status, calendar_year)
      VALUES (
        ${caller.tenantId}::uuid,
        ${input.date}::date,
        ${input.name},
        ${input.kind},
        'draft',
        ${Number(input.date.slice(0, 4))}
      )
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, holiday_date::text AS date, name, kind,
        source_status AS "sourceStatus", calendar_year AS "calendarYear",
        to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = requiredRow(rows[0], "holiday insert returned no row");
    await audit(tx, caller, "holiday.create", "att_holidays", row.id, row.before_json, row.after_json);
    return {
      id: row.id,
      date: row.date,
      name: row.name,
      kind: row.kind,
      sourceStatus: row.sourceStatus,
      calendarYear: row.calendarYear,
    };
  });
}

export async function listLeaveTypes(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
): Promise<LeaveTypeView[]> {
  const tenantId = tenantOf(caller);
  return appDb.withTenantContext(tenantId, async (tx) => {
    await ensureLeaveTypes(tx, tenantId);
    return readLeaveTypes(tx);
  });
}

export async function setBersamaDeduction(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  id: string,
  body: unknown,
): Promise<LeaveTypeView> {
  assertWriter(caller);
  const typeId = assertUuid(id, "id");
  const record = asRecord(body);
  if (!record || typeof record.deductsAnnual !== "boolean") {
    throw invalid("deductsAnnual", "must be true or false.");
  }
  const deductsAnnual = record.deductsAnnual;
  return write(appDb, caller, async (tx) => {
    await ensureLeaveTypes(tx, caller.tenantId);
    const rows = queryRows<LeaveTypeView & { before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      UPDATE att_leave_types SET
        deducts_annual = ${deductsAnnual},
        updated_at = now()
      WHERE id = ${typeId}::uuid AND code = 'cuti_bersama'
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, code, name, tenure_months AS "tenureMonths",
        entitlement_days AS "entitlementDays", deducts_annual AS "deductsAnnual",
        deduction_toggle AS "deductionToggle",
        to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = rows[0];
    if (!row) throw new ScheduleError(400, "toggle_not_supported", "Only Cuti Bersama has a deduction toggle.");
    await audit(tx, caller, "leave_type.update", "att_leave_types", row.id, row.before_json, row.after_json);
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      tenureMonths: row.tenureMonths,
      entitlementDays: row.entitlementDays,
      deductsAnnual: row.deductsAnnual,
      deductionToggle: row.deductionToggle,
    };
  });
}

export async function listBalances(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  query: unknown,
): Promise<BalanceView[]> {
  const tenantId = tenantOf(caller);
  const record = asRecord(query) ?? {};
  const employeeId = typeof record.employeeId === "string" ? assertUuid(record.employeeId, "employeeId") : null;
  return appDb.withTenantContext(tenantId, async (tx) => {
    await ensureLeaveTypes(tx, tenantId);
    return queryRows<BalanceView>(await tx.execute(sql`
      SELECT b.id::text AS id, b.employee_id::text AS "employeeId", t.code AS "leaveTypeCode",
             b.balance_year AS "balanceYear", b.entitled_days AS "entitledDays", b.used_days AS "usedDays"
      FROM att_leave_balances b
      JOIN att_leave_types t ON t.id = b.leave_type_id
      WHERE (${employeeId}::uuid IS NULL OR b.employee_id = ${employeeId}::uuid)
      ORDER BY b.balance_year, t.code
    `));
  });
}

export async function ensureAnnualBalance(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<BalanceView> {
  assertWriter(caller);
  const record = asRecord(body);
  if (!record) throw new ScheduleError(400, "invalid_body", "Body must be an object.");
  const employeeId = assertUuid(record.employeeId, "employeeId");
  if (typeof record.joinedOn !== "string" || typeof record.asOf !== "string") {
    throw invalid("joinedOn", "and asOf must be dates.");
  }
  const entitled = annualEntitlement(record.joinedOn, record.asOf);
  if (entitled === null) throw invalid("asOf", "must be on or after joinedOn.");
  const year = Number(record.asOf.slice(0, 4));
  return write(appDb, caller, async (tx) => {
    await ensureLeaveTypes(tx, caller.tenantId);
    const rows = queryRows<BalanceView & { before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      INSERT INTO att_leave_balances (tenant_id, employee_id, leave_type_id, balance_year, entitled_days, used_days)
      SELECT ${caller.tenantId}::uuid, ${employeeId}::uuid, id, ${year}, ${entitled}, 0
      FROM att_leave_types
      WHERE code = 'cuti_tahunan'
      ON CONFLICT (tenant_id, employee_id, leave_type_id, balance_year) DO UPDATE SET
        entitled_days = GREATEST(EXCLUDED.entitled_days, att_leave_balances.used_days),
        updated_at = now()
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id,
        employee_id::text AS "employeeId",
        'cuti_tahunan' AS "leaveTypeCode",
        balance_year AS "balanceYear",
        entitled_days AS "entitledDays",
        used_days AS "usedDays",
        to_jsonb(before_row) AS before_json,
        to_jsonb(after_row) AS after_json
    `));
    const row = requiredRow(rows[0], "balance insert returned no row");
    await audit(tx, caller, "leave_balance.ensure", "att_leave_balances", row.id, row.before_json, row.after_json);
    return {
      id: row.id,
      employeeId: row.employeeId,
      leaveTypeCode: row.leaveTypeCode,
      balanceYear: row.balanceYear,
      entitledDays: row.entitledDays,
      usedDays: row.usedDays,
    };
  });
}

export async function listLeaveRequests(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
): Promise<LeaveRequestView[]> {
  const tenantId = tenantOf(caller);
  return appDb.withTenantContext(tenantId, async (tx) => readLeaveRequests(tx, null));
}

export async function createLeaveRequest(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<LeaveRequestView> {
  tenantOf(caller);
  const record = asRecord(body);
  if (!record) throw new ScheduleError(400, "invalid_body", "Body must be an object.");
  const employeeId = assertUuid(record.employeeId, "employeeId");
  if (typeof record.leaveTypeCode !== "string" || typeof record.startDate !== "string" || typeof record.endDate !== "string") {
    throw invalid("leaveTypeCode", "startDate, and endDate are required.");
  }
  const dayCount = inclusiveDays(record.startDate, record.endDate);
  if (dayCount === null) throw invalid("endDate", "must be on or after startDate.");
  const leaveTypeCode = record.leaveTypeCode;
  const startDate = record.startDate;
  const endDate = record.endDate;
  return write(appDb, caller, async (tx) => {
    await ensureLeaveTypes(tx, caller.tenantId);
    const type = queryRows<{ id: string }>(await tx.execute(sql`
      SELECT id::text AS id FROM att_leave_types WHERE code = ${leaveTypeCode}
    `));
    if (!type[0]) throw invalid("leaveTypeCode", "is not a leave type.");
    const rows = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      INSERT INTO att_leave_requests (
        tenant_id, employee_id, leave_type_id, start_date, end_date, day_count, requested_by_user_id
      ) VALUES (
        ${caller.tenantId}::uuid,
        ${employeeId}::uuid,
        ${type[0].id}::uuid,
        ${startDate}::date,
        ${endDate}::date,
        ${dayCount},
        ${caller.userId}::uuid
      )
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = requiredRow(rows[0], "leave request insert returned no row");
    await audit(tx, caller, "leave_request.create", "att_leave_requests", row.id, row.before_json, row.after_json);
    const saved = await readLeaveRequests(tx, row.id);
    return requiredRow(saved[0], "leave request was not readable");
  });
}

export async function decideLeave(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  id: string,
  body: unknown,
): Promise<LeaveRequestView> {
  tenantOf(caller);
  const requestId = assertUuid(id, "id");
  const decision = parseDecision(body);
  return write(appDb, caller, async (tx) => {
    const current = queryRows<{
      id: string;
      employee_id: string;
      start_date: string;
      end_date: string;
      day_count: number;
      status: string;
      code: string;
    }>(await tx.execute(sql`
      SELECT r.id::text AS id, r.employee_id::text AS employee_id, r.start_date::text AS start_date,
             r.end_date::text AS end_date, r.day_count, r.status, t.code
      FROM att_leave_requests r
      JOIN att_leave_types t ON t.id = r.leave_type_id
      WHERE r.id = ${requestId}::uuid
      FOR UPDATE OF r
    `));
    const row = current[0];
    if (!row) throw new ScheduleError(404, "not_found", "Leave request not found.");
    const next = await nextStatus(tx, caller, row.status, decision.decision);
    const recorded = decision.decision === "approve" ? "approved" : "rejected";
    await assertRangeUnlocked(tx, row.start_date, row.end_date);
    const updated = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      UPDATE att_leave_requests SET
        status = ${next.status},
        line_decision = CASE WHEN ${next.step} = 'line' THEN ${recorded} ELSE line_decision END,
        line_decided_by = CASE WHEN ${next.step} = 'line' THEN ${caller.userId}::uuid ELSE line_decided_by END,
        line_decided_at = CASE WHEN ${next.step} = 'line' THEN now() ELSE line_decided_at END,
        final_decision = CASE WHEN ${next.step} = 'final' THEN ${recorded} ELSE final_decision END,
        final_decided_by = CASE WHEN ${next.step} = 'final' THEN ${caller.userId}::uuid ELSE final_decided_by END,
        final_decided_at = CASE WHEN ${next.step} = 'final' THEN now() ELSE final_decided_at END,
        decision_reason = ${decision.reason},
        updated_at = now()
      WHERE id = ${requestId}::uuid
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const saved = requiredRow(updated[0], "leave decision returned no row");
    if (next.status === "approved") await deductAnnual(tx, row.employee_id, row.code, row.start_date, row.day_count);
    await audit(tx, caller, "leave_request.decide", "att_leave_requests", saved.id, saved.before_json, saved.after_json);
    return requiredRow((await readLeaveRequests(tx, saved.id))[0], "leave request was not readable");
  });
}

export async function listOvertimeRequests(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
): Promise<OvertimeRequestView[]> {
  const tenantId = tenantOf(caller);
  return appDb.withTenantContext(tenantId, async (tx) => readOvertime(tx, null));
}

export async function createOvertimeRequest(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<OvertimeRequestView> {
  tenantOf(caller);
  const input = parseOvertime(body);
  return write(appDb, caller, async (tx) => {
    const holiday = queryRows<{ holiday_date: string }>(await tx.execute(sql`
      SELECT holiday_date::text AS holiday_date FROM att_holidays WHERE holiday_date = ${input.workDate}::date
    `));
    const holidays = new Set(holiday[0] ? [input.workDate] : []);
    const dayType = deriveDayType(input.workDate, input.workweekType, holidays);
    const rows = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      INSERT INTO att_overtime_requests (
        tenant_id, employee_id, work_date, starts_at, ends_at, workweek_type, day_type,
        requested_minutes, requested_by_user_id
      ) VALUES (
        ${caller.tenantId}::uuid,
        ${input.employeeId}::uuid,
        ${input.workDate}::date,
        ${input.startsAt}::timestamptz,
        ${input.endsAt}::timestamptz,
        ${input.workweekType},
        ${dayType},
        ${input.requestedMinutes},
        ${caller.userId}::uuid
      )
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = requiredRow(rows[0], "overtime insert returned no row");
    await audit(tx, caller, "overtime_request.create", "att_overtime_requests", row.id, row.before_json, row.after_json);
    return requiredRow((await readOvertime(tx, row.id))[0], "overtime request was not readable");
  });
}

export async function decideOvertime(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  id: string,
  body: unknown,
): Promise<OvertimeRequestView> {
  tenantOf(caller);
  const requestId = assertUuid(id, "id");
  const decision = parseDecision(body);
  return write(appDb, caller, async (tx) => {
    const current = queryRows<{
      id: string;
      work_date: string;
      status: string;
      requested_minutes: number;
    }>(await tx.execute(sql`
      SELECT id::text AS id, work_date::text AS work_date, status, requested_minutes
      FROM att_overtime_requests
      WHERE id = ${requestId}::uuid
      FOR UPDATE
    `));
    const row = current[0];
    if (!row) throw new ScheduleError(404, "not_found", "Overtime request not found.");
    const next = await nextStatus(tx, caller, row.status, decision.decision);
    const recorded = decision.decision === "approve" ? "approved" : "rejected";
    await assertRangeUnlocked(tx, row.work_date, row.work_date);
    const approved = approvedMinutesFor(decision, next.status, row.requested_minutes);
    const updated = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      UPDATE att_overtime_requests SET
        status = ${next.status},
        line_decision = CASE WHEN ${next.step} = 'line' THEN ${recorded} ELSE line_decision END,
        line_decided_by = CASE WHEN ${next.step} = 'line' THEN ${caller.userId}::uuid ELSE line_decided_by END,
        line_decided_at = CASE WHEN ${next.step} = 'line' THEN now() ELSE line_decided_at END,
        final_decision = CASE WHEN ${next.step} = 'final' THEN ${recorded} ELSE final_decision END,
        final_decided_by = CASE WHEN ${next.step} = 'final' THEN ${caller.userId}::uuid ELSE final_decided_by END,
        final_decided_at = CASE WHEN ${next.step} = 'final' THEN now() ELSE final_decided_at END,
        approved_minutes = CASE
          WHEN ${next.status} = 'approved' THEN ${approved}
          ELSE approved_minutes
        END,
        decision_reason = ${decision.reason},
        updated_at = now()
      WHERE id = ${requestId}::uuid
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const saved = requiredRow(updated[0], "overtime decision returned no row");
    await audit(
      tx,
      caller,
      "overtime_request.decide",
      "att_overtime_requests",
      saved.id,
      saved.before_json,
      saved.after_json,
    );
    return requiredRow((await readOvertime(tx, saved.id))[0], "overtime request was not readable");
  });
}

export async function listDelegations(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
): Promise<DelegationView[]> {
  const tenantId = tenantOf(caller);
  return appDb.withTenantContext(tenantId, async (tx) => readDelegations(tx));
}

export async function createDelegation(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  body: unknown,
): Promise<DelegationView> {
  tenantOf(caller);
  const input = parseDelegation(body);
  if (!canWriteOrg(caller.role) && !(caller.userId === input.delegatorUserId && caller.role === input.roleCode)) {
    throw new ScheduleError(403, "forbidden", "You cannot delegate that role.");
  }
  return write(appDb, caller, async (tx) => {
    const rows = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      INSERT INTO att_approval_delegations (
        tenant_id, delegator_user_id, delegate_user_id, role_code, starts_at, ends_at
      ) VALUES (
        ${caller.tenantId}::uuid,
        ${input.delegatorUserId}::uuid,
        ${input.delegateUserId}::uuid,
        ${input.roleCode},
        ${input.startsAt}::timestamptz,
        ${input.endsAt}::timestamptz
      )
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = requiredRow(rows[0], "delegation insert returned no row");
    await audit(tx, caller, "delegation.create", "att_approval_delegations", row.id, row.before_json, row.after_json);
    const saved = (await readDelegations(tx)).find((item) => item.id === row.id);
    return requiredRow(saved, "delegation was not readable");
  });
}

export async function revokeDelegation(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  id: string,
): Promise<DelegationView> {
  tenantOf(caller);
  const delegationId = assertUuid(id, "id");
  return write(appDb, caller, async (tx) => {
    const existing = queryRows<{ delegator_user_id: string }>(await tx.execute(sql`
      SELECT delegator_user_id::text AS delegator_user_id
      FROM att_approval_delegations
      WHERE id = ${delegationId}::uuid
      FOR UPDATE
    `));
    const current = existing[0];
    if (!current) throw new ScheduleError(404, "not_found", "Delegation not found.");
    if (!canWriteOrg(caller.role) && caller.userId !== current.delegator_user_id) {
      throw new ScheduleError(403, "forbidden", "You cannot revoke that delegation.");
    }
    const rows = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(await tx.execute(sql`
      UPDATE att_approval_delegations SET revoked_at = now(), updated_at = now()
      WHERE id = ${delegationId}::uuid AND revoked_at IS NULL
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        id::text AS id, to_jsonb(before_row) AS before_json, to_jsonb(after_row) AS after_json
    `));
    const row = rows[0];
    if (!row) throw new ScheduleError(409, "already_decided", "That delegation is already revoked.");
    await audit(tx, caller, "delegation.revoke", "att_approval_delegations", row.id, row.before_json, row.after_json);
    const saved = (await readDelegations(tx)).find((item) => item.id === row.id);
    return requiredRow(saved, "delegation was not readable");
  });
}

export async function lockPeriod(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  yearMonth: string,
): Promise<LockResult> {
  assertWriter(caller);
  const bounds = monthBounds(yearMonth);
  if (!bounds) throw invalid("yearMonth", "must be YYYY-MM.");
  return write(appDb, caller, async (tx) => {
    const counts = queryRows<{ employee_count: number; summary_count: number }>(await tx.execute(sql`
      WITH employees AS (
        SELECT employee_id FROM att_rosters
        WHERE work_date >= ${bounds.start}::date AND work_date <= ${bounds.end}::date
        UNION
        SELECT employee_id FROM att_overtime_requests
        WHERE work_date >= ${bounds.start}::date AND work_date <= ${bounds.end}::date
        UNION
        SELECT employee_id FROM att_leave_requests
        WHERE start_date <= ${bounds.end}::date AND end_date >= ${bounds.start}::date
      ),
      days AS (
        SELECT generate_series(${bounds.start}::date, ${bounds.end}::date, interval '1 day')::date AS work_date
      ),
      inserted AS (
        INSERT INTO att_daily_summaries (
          tenant_id, employee_id, work_date, status, late_minutes, worked_minutes,
          approved_overtime_minutes, locked_for_payroll_run_id, is_locked, locked_at
        )
        SELECT
          ${caller.tenantId}::uuid,
          grid.employee_id,
          grid.work_date,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM att_leave_requests leave
              WHERE leave.employee_id = grid.employee_id
                AND leave.status = 'approved'
                AND grid.work_date BETWEEN leave.start_date AND leave.end_date
            ) THEN 'leave'
            WHEN EXISTS (
              SELECT 1 FROM att_rosters roster
              WHERE roster.employee_id = grid.employee_id AND roster.work_date = grid.work_date
            ) THEN 'scheduled'
            ELSE 'open'
          END,
          0,
          0,
          COALESCE((
            SELECT SUM(overtime.approved_minutes)::int
            FROM att_overtime_requests overtime
            WHERE overtime.employee_id = grid.employee_id
              AND overtime.work_date = grid.work_date
              AND overtime.status = 'approved'
          ), 0),
          NULL,
          true,
          now()
        FROM (
          SELECT employees.employee_id, days.work_date FROM employees CROSS JOIN days
        ) AS grid
        ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET
          status = EXCLUDED.status,
          approved_overtime_minutes = EXCLUDED.approved_overtime_minutes,
          is_locked = true,
          locked_at = now(),
          updated_at = now()
        RETURNING employee_id
      )
      SELECT
        (SELECT count(*)::int FROM employees) AS employee_count,
        (SELECT count(*)::int FROM inserted) AS summary_count
    `));
    const count = requiredRow(counts[0], "period lock returned no count");
    const employeeCount = Number(count.employee_count);
    const summaryCount = Number(count.summary_count);
    await audit(tx, caller, "period.lock", "att_daily_summaries", null, {}, {
      yearMonth,
      employeeCount,
      summaryCount,
      lockedForPayrollRunId: null,
    });
    return { yearMonth, employeeCount, summaryCount };
  });
}

async function ensureLeaveTypes(tx: TenantTx, tenantId: string): Promise<void> {
  for (const type of defaultLeaveTypes) {
    await tx.execute(sql`
      INSERT INTO att_leave_types (
        tenant_id, code, name, tenure_months, entitlement_days, deducts_annual, deduction_toggle
      ) VALUES (
        ${tenantId}::uuid,
        ${type.code},
        ${type.name},
        ${type.tenureMonths},
        ${type.entitlementDays},
        ${type.deductsAnnual},
        ${type.deductionToggle}
      )
      ON CONFLICT (tenant_id, code) DO NOTHING
    `);
  }
}

async function readLeaveTypes(tx: TenantTx): Promise<LeaveTypeView[]> {
  return queryRows<LeaveTypeView>(await tx.execute(sql`
    SELECT id::text AS id, code, name, tenure_months AS "tenureMonths",
           entitlement_days AS "entitlementDays", deducts_annual AS "deductsAnnual",
           deduction_toggle AS "deductionToggle"
    FROM att_leave_types
    ORDER BY code
  `));
}

async function readLeaveRequests(tx: TenantTx, id: string | null): Promise<LeaveRequestView[]> {
  return queryRows<LeaveRequestView>(await tx.execute(sql`
    SELECT r.id::text AS id, r.employee_id::text AS "employeeId", t.code AS "leaveTypeCode",
           r.start_date::text AS "startDate", r.end_date::text AS "endDate", r.day_count AS "dayCount",
           r.status, r.decision_reason AS "decisionReason"
    FROM att_leave_requests r
    JOIN att_leave_types t ON t.id = r.leave_type_id
    WHERE (${id}::uuid IS NULL OR r.id = ${id}::uuid)
    ORDER BY r.start_date, r.id
  `));
}

async function readOvertime(tx: TenantTx, id: string | null): Promise<OvertimeRequestView[]> {
  const rows = queryRows<OvertimeRequestView>(await tx.execute(sql`
    SELECT id::text AS id, employee_id::text AS "employeeId", work_date::text AS "workDate",
           starts_at AS "startsAt", ends_at AS "endsAt", workweek_type AS "workweekType",
           day_type AS "dayType", requested_minutes AS "requestedMinutes",
           approved_minutes AS "approvedMinutes", status, decision_reason AS "decisionReason"
    FROM att_overtime_requests
    WHERE (${id}::uuid IS NULL OR id = ${id}::uuid)
    ORDER BY work_date, id
  `));
  return rows.map((row) => ({
    ...row,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    requestedMinutes: Number(row.requestedMinutes),
    approvedMinutes: row.approvedMinutes === null ? null : Number(row.approvedMinutes),
  }));
}

async function readDelegations(tx: TenantTx): Promise<DelegationView[]> {
  const rows = queryRows<DelegationView>(await tx.execute(sql`
    SELECT id::text AS id, delegator_user_id::text AS "delegatorUserId",
           delegate_user_id::text AS "delegateUserId", role_code AS "roleCode",
           starts_at AS "startsAt", ends_at AS "endsAt", revoked_at AS "revokedAt"
    FROM att_approval_delegations
    ORDER BY starts_at, id
  `));
  return rows.map((row) => ({
    ...row,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
  }));
}

async function nextStatus(
  tx: TenantTx,
  caller: AttendanceCaller,
  status: string,
  decision: "approve" | "reject",
): Promise<{ status: string; step: "line" | "final" }> {
  if (status === "approved" || status === "rejected") {
    throw new ScheduleError(409, "already_decided", "This request is already decided.");
  }
  if (status === "pending_line_manager") {
    if (!(await actsAs(tx, caller, "line_manager"))) {
      throw new ScheduleError(403, "forbidden", "A line manager decides this step.");
    }
    return { status: decision === "approve" ? "pending_final" : "rejected", step: "line" };
  }
  if (status === "pending_final") {
    if (!(await actsAs(tx, caller, "branch_manager")) && !(await actsAs(tx, caller, "hr_admin"))) {
      throw new ScheduleError(403, "forbidden", "A branch manager or HR admin decides this step.");
    }
    return { status: decision === "approve" ? "approved" : "rejected", step: "final" };
  }
  throw new ScheduleError(409, "already_decided", "This request is already decided.");
}

async function actsAs(tx: TenantTx, caller: AttendanceCaller, role: ApprovalRole): Promise<boolean> {
  if (caller.role === role) return true;
  const rows = queryRows<{ id: string }>(await tx.execute(sql`
    SELECT id::text AS id
    FROM att_approval_delegations
    WHERE delegate_user_id = ${caller.userId}::uuid
      AND role_code = ${role}
      AND revoked_at IS NULL
      AND starts_at <= now()
      AND ends_at > now()
    LIMIT 1
  `));
  return rows.length > 0;
}

async function assertRangeUnlocked(tx: TenantTx, start: string, end: string): Promise<void> {
  const locked = queryRows<{ id: string }>(await tx.execute(sql`
    SELECT id::text AS id
    FROM att_daily_summaries
    WHERE is_locked = true
      AND work_date >= ${start}::date
      AND work_date <= ${end}::date
    LIMIT 1
  `));
  if (locked[0]) throw new ScheduleError(409, "period_locked", "This day is locked for payroll.");
}

async function deductAnnual(
  tx: TenantTx,
  employeeId: string,
  leaveCode: string,
  startDate: string,
  dayCount: number,
): Promise<void> {
  const type = queryRows<{ deducts_annual: boolean }>(await tx.execute(sql`
    SELECT deducts_annual FROM att_leave_types WHERE code = ${leaveCode}
  `));
  const bersama = type[0]?.deducts_annual === true;
  if (leaveCode !== "cuti_tahunan" && !(leaveCode === "cuti_bersama" && bersama)) return;
  const year = Number(startDate.slice(0, 4));
  const updated = queryRows<{ id: string }>(await tx.execute(sql`
    UPDATE att_leave_balances b SET
      used_days = b.used_days + ${dayCount},
      updated_at = now()
    FROM att_leave_types t
    WHERE b.leave_type_id = t.id
      AND t.code = 'cuti_tahunan'
      AND b.employee_id = ${employeeId}::uuid
      AND b.balance_year = ${year}
      AND b.used_days + ${dayCount} <= b.entitled_days
    RETURNING b.id::text AS id
  `));
  if (!updated[0]) {
    throw new ScheduleError(409, "insufficient_balance", "Cuti Tahunan balance is not enough.");
  }
}

function approvedMinutesFor(
  decision: DecisionInput,
  status: string,
  requested: number,
): number {
  if (status !== "approved") return requested;
  const minutes = decision.approvedMinutes ?? requested;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > requested) {
    throw invalid("approvedMinutes", "must be between 1 and the requested minutes.");
  }
  return minutes;
}

async function audit(
  tx: TenantTx,
  caller: AttendanceCaller,
  action: string,
  resourceType: string,
  resourceId: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await provisionTenantKeys(tx, caller.tenantId);
  await appendAuditEvent(
    tx,
    {
      tenantId: caller.tenantId,
      actorUserId: caller.userId,
      actorRole: caller.role,
      action,
      resourceType,
      resourceId,
      diff: { before: asObject(before), after: asObject(after) },
      aiProposalId: null,
      supportGrantId: null,
      ipAddress: clip(caller.ipAddress, 64),
      userAgent: clip(caller.userAgent, 512),
    },
    { requireTenantKeys: true },
  );
}

async function write<T>(
  appDb: TenantDatabase,
  caller: AttendanceCaller,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  try {
    return await appDb.withTenantContext(caller.tenantId, fn);
  } catch (error) {
    if (error instanceof ScheduleError) throw error;
    if (errorCode(error) === "23505") throw new ScheduleError(409, "conflict", "That record already exists.");
    if (errorCode(error) === "23503") throw new ScheduleError(409, "conflict", "The record is still in use.");
    if (errorCode(error) === "23514") throw new ScheduleError(400, "invalid_field", "A value is outside the allowed range.");
    throw error;
  }
}

function assertWriter(caller: AttendanceCaller): void {
  tenantOf(caller);
  if (!canWriteOrg(caller.role)) {
    throw new ScheduleError(403, "forbidden", "Only an owner or HR admin can change the company.");
  }
}

function tenantOf(caller: AttendanceCaller): string {
  caller.tenantId = assertUuid(caller.tenantId, "tenantId");
  caller.userId = assertUuid(caller.userId, "userId");
  return caller.tenantId;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(field, "must be a uuid.");
  return value.toLowerCase();
}

function parseShift(body: unknown): {
  code: string;
  name: string;
  startLocalTime: string;
  endLocalTime: string;
  graceMinutes: number;
  workweekType: WorkweekType;
  isOvernight: boolean;
} {
  const record = asRecord(body);
  if (!record) throw new ScheduleError(400, "invalid_body", "Body must be an object.");
  if (typeof record.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(record.code)) {
    throw invalid("code", "must be 1 to 32 letters, digits, _ or -.");
  }
  if (typeof record.name !== "string" || record.name.trim().length === 0 || record.name.trim().length > 80) {
    throw invalid("name", "must be 1 to 80 characters.");
  }
  if (typeof record.startLocalTime !== "string" || !HHMM.test(record.startLocalTime)) {
    throw invalid("startLocalTime", "must be HH:MM.");
  }
  if (typeof record.endLocalTime !== "string" || !HHMM.test(record.endLocalTime)) {
    throw invalid("endLocalTime", "must be HH:MM.");
  }
  const graceMinutes = record.graceMinutes === undefined ? 0 : record.graceMinutes;
  if (typeof graceMinutes !== "number" || !Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 180) {
    throw invalid("graceMinutes", "must be a whole number from 0 to 180.");
  }
  if (typeof record.workweekType !== "string" || !isWorkweekType(record.workweekType)) {
    throw invalid("workweekType", "must be 5_day or 6_day.");
  }
  const isOvernight = record.isOvernight === undefined ? false : record.isOvernight;
  if (typeof isOvernight !== "boolean") throw invalid("isOvernight", "must be true or false.");
  if (!isOvernight && record.endLocalTime <= record.startLocalTime) {
    throw invalid("endLocalTime", "must be after startLocalTime.");
  }
  return {
    code: record.code,
    name: record.name.trim(),
    startLocalTime: record.startLocalTime,
    endLocalTime: record.endLocalTime,
    graceMinutes,
    workweekType: record.workweekType,
    isOvernight,
  };
}

function parseAssignments(body: unknown): Array<{ employeeId: string; shiftId: string; workDate: string }> {
  const record = asRecord(body);
  if (!record || !Array.isArray(record.assignments) || record.assignments.length === 0 || record.assignments.length > 366) {
    throw invalid("assignments", "must be a list of 1 to 366 rows.");
  }
  return record.assignments.map((item) => {
    const row = asRecord(item);
    if (!row) throw invalid("assignments", "must contain objects.");
    const workDate = row.workDate;
    if (typeof workDate !== "string" || !isIsoDate(workDate)) throw invalid("workDate", "must be a date.");
    return {
      employeeId: assertUuid(row.employeeId, "employeeId"),
      shiftId: assertUuid(row.shiftId, "shiftId"),
      workDate,
    };
  });
}

function parseRange(query: unknown): { from: string; to: string; employeeId: string | null } {
  const record = asRecord(query) ?? {};
  if (typeof record.from !== "string" || !isIsoDate(record.from)) throw invalid("from", "must be a date.");
  if (typeof record.to !== "string" || !isIsoDate(record.to) || record.to < record.from) {
    throw invalid("to", "must be on or after from.");
  }
  const employeeId = record.employeeId === undefined ? null : assertUuid(record.employeeId, "employeeId");
  return { from: record.from, to: record.to, employeeId };
}

function parseYear(query: unknown): number | null {
  const record = asRecord(query) ?? {};
  if (record.year === undefined) return null;
  const year = typeof record.year === "string" ? Number(record.year) : record.year;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) {
    throw invalid("year", "must be a calendar year.");
  }
  return year;
}

function parseHoliday(body: unknown): { date: string; name: string; kind: "national" | "joint" } {
  const record = asRecord(body);
  if (!record) throw new ScheduleError(400, "invalid_body", "Body must be an object.");
  if (typeof record.date !== "string" || !isIsoDate(record.date)) throw invalid("date", "must be a date.");
  if (typeof record.name !== "string" || record.name.trim().length === 0 || record.name.trim().length > 120) {
    throw invalid("name", "must be 1 to 120 characters.");
  }
  const kind = record.kind === undefined ? "national" : record.kind;
  if (kind !== "national" && kind !== "joint") throw invalid("kind", "must be national or joint.");
  return { date: record.date, name: record.name.trim(), kind };
}

function parseOvertime(body: unknown): {
  employeeId: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  workweekType: WorkweekType;
  requestedMinutes: number;
} {
  const record = asRecord(body);
  if (!record) throw new ScheduleError(400, "invalid_body", "Body must be an object.");
  const employeeId = assertUuid(record.employeeId, "employeeId");
  if (typeof record.workDate !== "string" || !isIsoDate(record.workDate)) throw invalid("workDate", "must be a date.");
  if (typeof record.startsAt !== "string" || Number.isNaN(Date.parse(record.startsAt))) {
    throw invalid("startsAt", "must be a timestamp.");
  }
  if (typeof record.endsAt !== "string" || Number.isNaN(Date.parse(record.endsAt))) {
    throw invalid("endsAt", "must be a timestamp.");
  }
  if (typeof record.workweekType !== "string" || !isWorkweekType(record.workweekType)) {
    throw invalid("workweekType", "must be 5_day or 6_day.");
  }
  const minutes = Math.round((Date.parse(record.endsAt) - Date.parse(record.startsAt)) / 60_000);
  if (minutes < 1 || minutes > 720) throw invalid("endsAt", "must be 1 to 720 minutes after startsAt.");
  return {
    employeeId,
    workDate: record.workDate,
    startsAt: new Date(record.startsAt).toISOString(),
    endsAt: new Date(record.endsAt).toISOString(),
    workweekType: record.workweekType,
    requestedMinutes: minutes,
  };
}

function parseDecision(body: unknown): DecisionInput {
  const record = asRecord(body);
  if (!record) throw new ScheduleError(400, "invalid_body", "Body must be an object.");
  if (record.decision !== "approve" && record.decision !== "reject") {
    throw invalid("decision", "must be approve or reject.");
  }
  let reason: string | null = null;
  if (record.reason !== undefined) {
    if (typeof record.reason !== "string" || record.reason.trim().length > 200) {
      throw invalid("reason", "must be 200 characters or fewer.");
    }
    reason = record.reason.trim() || null;
  }
  let approvedMinutes: number | null = null;
  if (record.approvedMinutes !== undefined) {
    if (
      typeof record.approvedMinutes !== "number" ||
      !Number.isInteger(record.approvedMinutes) ||
      record.approvedMinutes < 1
    ) {
      throw invalid("approvedMinutes", "must be a positive integer.");
    }
    approvedMinutes = record.approvedMinutes;
  }
  return { decision: record.decision, reason, approvedMinutes };
}

function parseDelegation(body: unknown): {
  delegatorUserId: string;
  delegateUserId: string;
  roleCode: ApprovalRole;
  startsAt: string;
  endsAt: string;
} {
  const record = asRecord(body);
  if (!record) throw new ScheduleError(400, "invalid_body", "Body must be an object.");
  const delegatorUserId = assertUuid(record.delegatorUserId, "delegatorUserId");
  const delegateUserId = assertUuid(record.delegateUserId, "delegateUserId");
  if (delegatorUserId === delegateUserId) throw invalid("delegateUserId", "must be a different user.");
  if (typeof record.roleCode !== "string" || !isApprovalRole(record.roleCode)) {
    throw invalid("roleCode", "must be line_manager, branch_manager, or hr_admin.");
  }
  if (typeof record.startsAt !== "string" || Number.isNaN(Date.parse(record.startsAt))) {
    throw invalid("startsAt", "must be a timestamp.");
  }
  if (typeof record.endsAt !== "string" || Number.isNaN(Date.parse(record.endsAt))) {
    throw invalid("endsAt", "must be a timestamp.");
  }
  if (Date.parse(record.endsAt) <= Date.parse(record.startsAt)) {
    throw invalid("endsAt", "must be after startsAt.");
  }
  return {
    delegatorUserId,
    delegateUserId,
    roleCode: record.roleCode,
    startsAt: new Date(record.startsAt).toISOString(),
    endsAt: new Date(record.endsAt).toISOString(),
  };
}

function shiftView(row: ShiftRow): ShiftView {
  if (!isWorkweekType(row.workweek_type)) throw new Error("stored workweek is invalid");
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    startLocalTime: row.start_local_time.slice(0, 5),
    endLocalTime: row.end_local_time.slice(0, 5),
    graceMinutes: row.grace_minutes,
    workweekType: row.workweek_type,
    isOvernight: row.is_overnight,
  };
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(message);
  return row;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
