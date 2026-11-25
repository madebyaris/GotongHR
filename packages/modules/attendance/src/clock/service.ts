import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import type { ObjectStorage, PresignedPut } from "@gotonghr/storage";
import { sql } from "drizzle-orm";
import { ruleClockEvent, type Geofence, type PreviousPunch } from "./decide.ts";
import { ClockFieldError, ClockForbiddenError } from "./errors.ts";
import { asDate, asNumber, iso, rowsOf } from "./sql.ts";
import type { ClockCaller, ClockDecision, ClockEventInput, ReviewStatus, SelfieUploadInput } from "./types.ts";
import { uuidv7 } from "./uuid.ts";

export interface SelfieUpload {
  storageKey: string;
  maxContentLength: number;
  upload: PresignedPut;
}

interface EmployeeRow {
  id: string;
  branch_id: string;
  geofence_lat: number | string | null;
  geofence_lng: number | string | null;
  geofence_radius_m: number | null;
}

interface StoredRow {
  id: string;
  idempotency_key: string;
  review_status: ReviewStatus;
  review_reasons_json: unknown;
  geofence_ok: boolean;
  distance_meters: number | string | null;
  clock_drift_seconds: number | string;
  speed_kmh: number | string | null;
  captured_at: Date | string;
  received_at: Date | string;
}

interface PreviousRow {
  lat: number | string;
  lng: number | string;
  captured_at: Date | string;
}

/**
 * Presigns a selfie PUT. The database is not written. The object key is the only
 * value a later sync may store.
 */
export async function createSelfieUpload(
  storage: ObjectStorage,
  caller: ClockCaller,
  input: SelfieUploadInput,
): Promise<SelfieUpload> {
  const ext = input.contentType === "image/webp" ? "webp" : "jpg";
  const storageKey = `selfies/${caller.tenantId.toLowerCase()}/${uuidv7()}.${ext}`;
  const upload = await storage.presignPut({
    key: storageKey,
    contentType: input.contentType,
    maxBytes: input.contentLength,
  });
  return { storageKey, maxContentLength: input.contentLength, upload };
}

/**
 * Inserts each new punch with ON CONFLICT (tenant_id, idempotency_key) DO NOTHING.
 * A duplicate key returns the stored decision and does not write a second row.
 */
export async function syncClockEvents(
  database: TenantDatabase,
  caller: ClockCaller,
  events: readonly ClockEventInput[],
  now: Date,
): Promise<ClockDecision[]> {
  return database.withTenantContext(caller.tenantId, async (tx) => {
    const decisions: ClockDecision[] = [];
    for (const event of events) {
      const existing = await findByKey(tx, event.idempotencyKey);
      if (existing) {
        decisions.push(decisionFromRow(existing, true));
        continue;
      }
      const employee = await loadEmployee(tx, event.employeeId);
      if (!employee) {
        throw new ClockFieldError([{ field: "employeeId", message: "Employee was not found." }]);
      }
      assertBranchScope(caller, employee.branch_id);
      const previous = await previousPunch(tx, event.employeeId, event.capturedAt);
      const ruling = ruleClockEvent({
        capturedAt: event.capturedAt,
        receivedAt: now,
        syncSource: event.syncSource,
        point: { lat: event.lat, lng: event.lng },
        geofence: geofenceOf(employee),
        previous,
        mockLocationFlag: event.mockLocationFlag,
        livenessOk: event.livenessOk,
        branchMismatch: branchMismatch(event.branchId, employee.branch_id),
      });
      const inserted = rowsOf<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO att_clock_events (
            tenant_id, employee_id, branch_id, idempotency_key, punch_type,
            captured_at, received_at, clock_drift_seconds, sync_source,
            lat, lng, accuracy_meters, distance_meters, geofence_ok, speed_kmh,
            liveness_ok, mock_location_flag, selfie_storage_key,
            review_status, review_reasons_json
          ) VALUES (
            ${caller.tenantId}::uuid,
            ${event.employeeId}::uuid,
            ${employee.branch_id}::uuid,
            ${event.idempotencyKey}::uuid,
            ${event.punchType},
            ${event.capturedAt.toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz,
            ${ruling.clockDriftSeconds},
            ${event.syncSource},
            ${event.lat},
            ${event.lng},
            ${event.accuracyMeters},
            ${ruling.distanceMeters},
            ${ruling.geofenceOk},
            ${ruling.speedKmh},
            ${event.livenessOk},
            ${event.mockLocationFlag},
            ${event.selfieStorageKey},
            ${ruling.reviewStatus},
            ${JSON.stringify(ruling.reviewReasons)}::jsonb
          )
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
          RETURNING id::text AS id
        `),
      );
      const id = inserted[0]?.id;
      if (!id) {
        const raced = await findByKey(tx, event.idempotencyKey);
        if (!raced) throw new Error("clock insert returned no row");
        decisions.push(decisionFromRow(raced, true));
        continue;
      }
      decisions.push({
        id,
        idempotencyKey: event.idempotencyKey,
        duplicate: false,
        reviewStatus: ruling.reviewStatus,
        reviewReasons: ruling.reviewReasons,
        geofenceOk: ruling.geofenceOk,
        distanceMeters: ruling.distanceMeters,
        clockDriftSeconds: ruling.clockDriftSeconds,
        speedKmh: ruling.speedKmh,
        capturedAt: event.capturedAt.toISOString(),
        receivedAt: now.toISOString(),
      });
    }
    return decisions;
  });
}

function assertBranchScope(caller: ClockCaller, branchId: string): void {
  if (caller.scopeBranchIds.length === 0) return;
  const allowed = new Set(caller.scopeBranchIds.map((id) => id.toLowerCase()));
  if (!allowed.has(branchId.toLowerCase())) throw new ClockForbiddenError();
}

function branchMismatch(claimed: string | null, actual: string): boolean {
  return claimed !== null && claimed.toLowerCase() !== actual.toLowerCase();
}

function geofenceOf(row: EmployeeRow): Geofence | null {
  if (row.geofence_lat === null || row.geofence_lng === null || row.geofence_radius_m === null) {
    return null;
  }
  const lat = asNumber(row.geofence_lat);
  const lng = asNumber(row.geofence_lng);
  if (lat === null || lng === null) return null;
  return { lat, lng, radiusMeters: row.geofence_radius_m };
}

async function loadEmployee(tx: Query, employeeId: string): Promise<EmployeeRow | null> {
  const rows = rowsOf<EmployeeRow>(
    await tx.execute(sql`
      SELECT
        e.id::text AS id,
        e.branch_id::text AS branch_id,
        b.geofence_lat::float8 AS geofence_lat,
        b.geofence_lng::float8 AS geofence_lng,
        b.geofence_radius_m
      FROM hr_employees AS e
      JOIN id_branches AS b
        ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
      WHERE e.id = ${employeeId}::uuid
    `),
  );
  return rows[0] ?? null;
}

async function previousPunch(tx: Query, employeeId: string, capturedAt: Date): Promise<PreviousPunch | null> {
  const rows = rowsOf<PreviousRow>(
    await tx.execute(sql`
      SELECT lat::float8 AS lat, lng::float8 AS lng, captured_at
      FROM att_clock_events
      WHERE employee_id = ${employeeId}::uuid
        AND captured_at < ${capturedAt.toISOString()}::timestamptz
      ORDER BY captured_at DESC
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  const lat = asNumber(row.lat);
  const lng = asNumber(row.lng);
  if (lat === null || lng === null) return null;
  return { lat, lng, capturedAt: asDate(row.captured_at) };
}

async function findByKey(tx: Query, idempotencyKey: string): Promise<StoredRow | null> {
  const rows = rowsOf<StoredRow>(
    await tx.execute(sql`
      SELECT
        id::text AS id,
        idempotency_key::text AS idempotency_key,
        review_status,
        review_reasons_json,
        geofence_ok,
        distance_meters::float8 AS distance_meters,
        clock_drift_seconds,
        speed_kmh::float8 AS speed_kmh,
        captured_at,
        received_at
      FROM att_clock_events
      WHERE idempotency_key = ${idempotencyKey}::uuid
    `),
  );
  return rows[0] ?? null;
}

function decisionFromRow(row: StoredRow, duplicate: boolean): ClockDecision {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    duplicate,
    reviewStatus: row.review_status,
    reviewReasons: readReasons(row.review_reasons_json),
    geofenceOk: row.geofence_ok,
    distanceMeters: asNumber(row.distance_meters),
    clockDriftSeconds: asNumber(row.clock_drift_seconds) ?? 0,
    speedKmh: asNumber(row.speed_kmh),
    capturedAt: iso(row.captured_at),
    receivedAt: iso(row.received_at),
  };
}

function readReasons(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

type Query = TenantTx;
