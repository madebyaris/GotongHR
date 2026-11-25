import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { missingPermission } from "./errors.ts";
import { anomalyReasons } from "./reasons.ts";
import { asBool, asNumber, branchScopeSql, iso, rowsOf } from "./sql.ts";
import type { AnomalyCaller, PendingAnomaly } from "./types.ts";

interface PendingRow {
  id: string;
  employee_id: string;
  full_name: string;
  employee_code: string;
  branch_name: string;
  timezone: string;
  punch_type: string;
  captured_at: Date | string;
  clock_drift_seconds: number | string;
  distance_meters: number | string | null;
  speed_kmh: number | string | null;
  geofence_ok: boolean | string;
  liveness_ok: boolean | string | null;
  mock_location_flag: boolean | string;
  sync_source: string;
  review_reasons_json: unknown;
}

/**
 * Pending punches for the web inbox and the phone inbox.
 * Both HTTP routes call this function. A punch leaves the list only when
 * `review_status` is no longer `needs_review`. The row stays on att_clock_events.
 */
export async function listPendingAnomalies(
  database: TenantDatabase,
  caller: AnomalyCaller,
): Promise<PendingAnomaly[]> {
  if (!caller.permissions.includes("attendance.approve")) throw missingPermission();
  return database.withTenantContext(caller.tenantId, async (tx) => listPending(tx, caller));
}

async function listPending(tx: TenantTx, caller: AnomalyCaller): Promise<PendingAnomaly[]> {
  const scope = branchScopeSql(caller.scopeBranchIds);
  const rows = rowsOf<PendingRow>(
    await tx.execute(sql`
      SELECT
        e.id::text AS id,
        e.employee_id::text AS employee_id,
        emp.full_name,
        emp.employee_code,
        b.name AS branch_name,
        b.timezone,
        e.punch_type,
        e.captured_at,
        e.clock_drift_seconds,
        e.distance_meters::float8 AS distance_meters,
        e.speed_kmh::float8 AS speed_kmh,
        e.geofence_ok,
        e.liveness_ok,
        e.mock_location_flag,
        e.sync_source,
        e.review_reasons_json
      FROM att_clock_events AS e
      JOIN hr_employees AS emp
        ON emp.id = e.employee_id AND emp.tenant_id = e.tenant_id
      JOIN id_branches AS b
        ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
      WHERE e.tenant_id = ${caller.tenantId}::uuid
        AND e.review_status = 'needs_review'
        AND ${scope}
      ORDER BY e.captured_at ASC, e.id ASC
    `),
  );
  return rows.map(toPending);
}

function toPending(row: PendingRow): PendingAnomaly {
  const geofenceOk = asBool(row.geofence_ok) === true;
  const livenessOk = asBool(row.liveness_ok);
  const mockLocationFlag = asBool(row.mock_location_flag) === true;
  const clockDriftSeconds = asNumber(row.clock_drift_seconds) ?? 0;
  const speedKmh = asNumber(row.speed_kmh);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.full_name,
    employeeCode: row.employee_code,
    branchName: row.branch_name,
    timezone: row.timezone,
    punchType: row.punch_type === "clock_out" ? "clock_out" : "clock_in",
    capturedAt: iso(row.captured_at),
    clockDriftSeconds,
    distanceMeters: asNumber(row.distance_meters),
    speedKmh,
    geofenceOk,
    livenessOk,
    mockLocationFlag,
    reasons: anomalyReasons({
      stored: row.review_reasons_json,
      geofenceOk,
      clockDriftSeconds,
      syncSource: row.sync_source,
      speedKmh,
      livenessOk,
      mockLocationFlag,
    }),
  };
}
