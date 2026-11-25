/**
 * Slice 3.1 schedules, leave, and overtime.
 * Slice 3.2 clock events belong in `src/clock` and re-export beside this file.
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
