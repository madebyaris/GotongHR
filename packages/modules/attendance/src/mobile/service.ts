import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { asNumber, iso, rowsOf } from "../clock/sql.ts";
import { defaultLeaveTypes } from "../schedules/calendar.ts";
import { addIsoDays, hhmm, localIsoDate } from "./dates.ts";
import { MobileError } from "./errors.ts";
import { BOOTSTRAP_DAY_COUNT, type BootstrapDay, type BootstrapPayload, type MobileCaller } from "./types.ts";

interface EmployeeRow {
  id: string;
  full_name: string;
  employee_code: string;
  employment_status: string;
  branch_id: string;
  branch_name: string;
  timezone: string;
  lat: number | string | null;
  lng: number | string | null;
  geofence_radius_m: number | null;
}

interface RosterRow {
  work_date: string;
  code: string;
  name: string;
  start_local_time: string;
  end_local_time: string;
}

interface LeaveRow {
  code: string;
  name: string;
}

interface BalanceRow {
  code: string;
  balance_year: number | string;
  entitled_days: number | string;
  used_days: number | string;
}

interface PunchRow {
  punch_type: string;
  captured_at: Date | string;
}

/**
 * One compact document for the clock screen.
 * Leave types are ensured so a new tenant still gets the statutory list.
 * Payslip fields stay out of this payload. Slice 4.5 owns that download.
 */
export async function loadBootstrap(
  database: TenantDatabase,
  caller: MobileCaller,
  now: Date,
): Promise<BootstrapPayload> {
  return database.withTenantContext(caller.tenantId, async (tx) => {
    const employee = await loadEmployee(tx, caller.userId);
    if (!employee) {
      throw new MobileError(404, "no_employee", "No employee is linked to this sign-in.");
    }
    const today = localIsoDate(now, employee.timezone);
    const end = addIsoDays(today, BOOTSTRAP_DAY_COUNT - 1);
    await ensureLeaveTypes(tx, caller.tenantId);
    const rosters = await loadRosters(tx, employee.id, today, end);
    const leaveTypes = await loadLeaveTypes(tx);
    const balances = await loadBalances(tx, employee.id, Number(today.slice(0, 4)));
    const punches = await loadPunches(tx, employee.id, today, employee.timezone);
    const byDate = new Map(rosters.map((row) => [row.work_date.slice(0, 10), row]));
    const days: BootstrapDay[] = [];
    for (let offset = 0; offset < BOOTSTRAP_DAY_COUNT; offset += 1) {
      const date = addIsoDays(today, offset);
      const row = byDate.get(date);
      days.push(
        row
          ? {
              date,
              code: row.code,
              start: hhmm(row.start_local_time),
              end: hhmm(row.end_local_time),
            }
          : { date, code: null, start: null, end: null },
      );
    }
    const todayRow = byDate.get(today);
    return {
      employee: {
        id: employee.id,
        name: employee.full_name,
        code: employee.employee_code,
        status: employee.employment_status,
      },
      branch: {
        id: employee.branch_id,
        name: employee.branch_name,
        timezone: employee.timezone,
        lat: roundCoord(asNumber(employee.lat)),
        lng: roundCoord(asNumber(employee.lng)),
        radiusM: employee.geofence_radius_m === null ? null : Number(employee.geofence_radius_m),
      },
      shift: todayRow
        ? {
            code: todayRow.code,
            name: todayRow.name,
            start: hhmm(todayRow.start_local_time),
            end: hhmm(todayRow.end_local_time),
          }
        : null,
      days,
      leaveTypes,
      balances,
      punches,
    };
  });
}

type Query = TenantTx;

async function loadEmployee(tx: Query, userId: string): Promise<EmployeeRow | null> {
  const rows = rowsOf<EmployeeRow>(
    await tx.execute(sql`
      SELECT
        e.id::text AS id,
        e.full_name,
        e.employee_code,
        e.employment_status,
        b.id::text AS branch_id,
        b.name AS branch_name,
        b.timezone,
        b.geofence_lat::float8 AS lat,
        b.geofence_lng::float8 AS lng,
        b.geofence_radius_m
      FROM hr_employees AS e
      JOIN id_branches AS b
        ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
      WHERE e.user_id = ${userId}::uuid
      LIMIT 1
    `),
  );
  return rows[0] ?? null;
}

async function loadRosters(tx: Query, employeeId: string, from: string, to: string): Promise<RosterRow[]> {
  return rowsOf<RosterRow>(
    await tx.execute(sql`
      SELECT
        r.work_date::text AS work_date,
        s.code,
        s.name,
        s.start_local_time::text AS start_local_time,
        s.end_local_time::text AS end_local_time
      FROM att_rosters AS r
      JOIN att_shifts AS s
        ON s.id = r.shift_id AND s.tenant_id = r.tenant_id
      WHERE r.employee_id = ${employeeId}::uuid
        AND r.work_date >= ${from}::date
        AND r.work_date <= ${to}::date
      ORDER BY r.work_date
    `),
  );
}

async function loadLeaveTypes(tx: Query): Promise<Array<{ code: string; name: string }>> {
  const rows = rowsOf<LeaveRow>(
    await tx.execute(sql`
      SELECT code, name
      FROM att_leave_types
      ORDER BY code
    `),
  );
  return rows.map((row) => ({ code: row.code, name: row.name }));
}

async function loadBalances(
  tx: Query,
  employeeId: string,
  year: number,
): Promise<BootstrapPayload["balances"]> {
  const rows = rowsOf<BalanceRow>(
    await tx.execute(sql`
      SELECT
        t.code,
        b.balance_year,
        b.entitled_days,
        b.used_days
      FROM att_leave_balances AS b
      JOIN att_leave_types AS t
        ON t.id = b.leave_type_id AND t.tenant_id = b.tenant_id
      WHERE b.employee_id = ${employeeId}::uuid
        AND b.balance_year = ${year}
      ORDER BY t.code
    `),
  );
  return rows.map((row) => ({
    code: row.code,
    year: Number(row.balance_year),
    entitled: Number(row.entitled_days),
    used: Number(row.used_days),
  }));
}

async function loadPunches(
  tx: Query,
  employeeId: string,
  today: string,
  timeZone: string,
): Promise<BootstrapPayload["punches"]> {
  const rows = rowsOf<PunchRow>(
    await tx.execute(sql`
      SELECT punch_type, captured_at
      FROM att_clock_events
      WHERE employee_id = ${employeeId}::uuid
        AND (captured_at AT TIME ZONE ${timeZone})::date = ${today}::date
      ORDER BY captured_at, id
    `),
  );
  return rows.map((row) => ({ type: row.punch_type, at: iso(row.captured_at) }));
}

async function ensureLeaveTypes(tx: Query, tenantId: string): Promise<void> {
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

function roundCoord(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 1e6) / 1e6;
}
