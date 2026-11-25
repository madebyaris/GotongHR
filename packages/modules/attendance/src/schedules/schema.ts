import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle shape of the schedule tables. `migrate.ts` is the DDL that is applied.
 * Change both together. Clock events stay out of this file so slice 3.2 can add them.
 */

function createdAt() {
  return timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`);
}

export const attShifts = pgTable(
  "att_shifts",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    startLocalTime: time("start_local_time").notNull(),
    endLocalTime: time("end_local_time").notNull(),
    graceMinutes: integer("grace_minutes").notNull().default(0),
    workweekType: text("workweek_type").notNull(),
    isOvernight: boolean("is_overnight").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("att_shifts_code_key").on(table.tenantId, table.code),
    index("att_shifts_tenant_idx").on(table.tenantId),
  ],
);

export const attRosters = pgTable(
  "att_rosters",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    shiftId: uuid("shift_id").notNull(),
    workDate: date("work_date", { mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("att_rosters_day_key").on(table.tenantId, table.employeeId, table.workDate),
    index("att_rosters_shift_idx").on(table.shiftId),
  ],
);

export const attHolidays = pgTable(
  "att_holidays",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    holidayDate: date("holiday_date", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    sourceStatus: text("source_status").notNull(),
    calendarYear: integer("calendar_year").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("att_holidays_date_key").on(table.tenantId, table.holidayDate),
    index("att_holidays_year_idx").on(table.tenantId, table.calendarYear),
  ],
);

export const attLeaveTypes = pgTable(
  "att_leave_types",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    tenureMonths: integer("tenure_months"),
    entitlementDays: integer("entitlement_days"),
    deductsAnnual: boolean("deducts_annual").notNull().default(false),
    deductionToggle: boolean("deduction_toggle").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("att_leave_types_code_key").on(table.tenantId, table.code)],
);

export const attLeaveBalances = pgTable(
  "att_leave_balances",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    balanceYear: integer("balance_year").notNull(),
    entitledDays: integer("entitled_days").notNull(),
    usedDays: integer("used_days").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("att_leave_balances_year_key").on(
      table.tenantId,
      table.employeeId,
      table.leaveTypeId,
      table.balanceYear,
    ),
  ],
);

export const attLeaveRequests = pgTable(
  "att_leave_requests",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    dayCount: integer("day_count").notNull(),
    status: text("status").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    lineDecision: text("line_decision"),
    lineDecidedBy: uuid("line_decided_by"),
    lineDecidedAt: timestamp("line_decided_at", { withTimezone: true, mode: "string" }),
    finalDecision: text("final_decision"),
    finalDecidedBy: uuid("final_decided_by"),
    finalDecidedAt: timestamp("final_decided_at", { withTimezone: true, mode: "string" }),
    decisionReason: text("decision_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("att_leave_requests_employee_idx").on(table.tenantId, table.employeeId, table.startDate),
    index("att_leave_requests_status_idx").on(table.tenantId, table.status),
  ],
);

export const attOvertimeRequests = pgTable(
  "att_overtime_requests",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    workDate: date("work_date", { mode: "string" }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "string" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "string" }).notNull(),
    workweekType: text("workweek_type").notNull(),
    dayType: text("day_type").notNull(),
    requestedMinutes: integer("requested_minutes").notNull(),
    approvedMinutes: integer("approved_minutes"),
    status: text("status").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    lineDecision: text("line_decision"),
    lineDecidedBy: uuid("line_decided_by"),
    lineDecidedAt: timestamp("line_decided_at", { withTimezone: true, mode: "string" }),
    finalDecision: text("final_decision"),
    finalDecidedBy: uuid("final_decided_by"),
    finalDecidedAt: timestamp("final_decided_at", { withTimezone: true, mode: "string" }),
    decisionReason: text("decision_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("att_overtime_requests_employee_idx").on(table.tenantId, table.employeeId, table.workDate),
    index("att_overtime_requests_status_idx").on(table.tenantId, table.status),
  ],
);

export const attApprovalDelegations = pgTable(
  "att_approval_delegations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    delegatorUserId: uuid("delegator_user_id").notNull(),
    delegateUserId: uuid("delegate_user_id").notNull(),
    roleCode: text("role_code").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "string" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("att_approval_delegations_delegate_idx").on(table.tenantId, table.delegateUserId, table.roleCode),
  ],
);

export const attDailySummaries = pgTable(
  "att_daily_summaries",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    workDate: date("work_date", { mode: "string" }).notNull(),
    status: text("status").notNull(),
    lateMinutes: integer("late_minutes").notNull().default(0),
    workedMinutes: integer("worked_minutes").notNull().default(0),
    approvedOvertimeMinutes: integer("approved_overtime_minutes").notNull().default(0),
    lockedForPayrollRunId: uuid("locked_for_payroll_run_id"),
    isLocked: boolean("is_locked").notNull().default(false),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("att_daily_summaries_day_key").on(table.tenantId, table.employeeId, table.workDate),
    index("att_daily_summaries_locked_idx").on(table.tenantId, table.workDate, table.isLocked),
  ],
);
