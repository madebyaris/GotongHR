/**
 * Schedules, leave, and overtime live in src/schedules.
 * Clock events live in src/clock.
 * The anomaly inbox lives in src/anomalies and reads those punches.
 */
export type { AttendanceCaller } from "./schedules/auth.ts";
export { migrateAttendance } from "./schedules/migrate.ts";
export type { AttendanceMigrateInput } from "./schedules/migrate.ts";
export { registerAttendanceRoutes } from "./schedules/routes.ts";
export type { AttendanceRouteDeps } from "./schedules/routes.ts";
export {
  attApprovalDelegations,
  attDailySummaries,
  attHolidays,
  attLeaveBalances,
  attLeaveRequests,
  attLeaveTypes,
  attOvertimeRequests,
  attRosters,
  attShifts,
} from "./schedules/schema.ts";
export {
  attClockEvents,
  migrateClock,
  registerClockRoutes,
} from "./clock/index.ts";
export type { ClockCaller, ClockMigrateInput, ClockRouteDeps } from "./clock/index.ts";
export { migrateAnomalies, registerAnomalyRoutes, listPendingAnomalies, reviewAnomaly } from "./anomalies/index.ts";
export type {
  AnomalyCaller,
  AnomalyMigrateInput,
  AnomalyRouteDeps,
  PendingAnomaly,
  ReviewedAnomaly,
} from "./anomalies/index.ts";
