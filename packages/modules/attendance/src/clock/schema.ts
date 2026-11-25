import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle shape of att_clock_events. migrate.ts is the DDL that is applied.
 * selfie_storage_key is an object key. Image bytes are not a column.
 */

export const attClockEvents = pgTable(
  "att_clock_events",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    punchType: text("punch_type").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    clockDriftSeconds: integer("clock_drift_seconds").notNull(),
    syncSource: text("sync_source").notNull(),
    lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
    lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
    accuracyMeters: numeric("accuracy_meters", { precision: 10, scale: 2 }),
    distanceMeters: numeric("distance_meters", { precision: 12, scale: 2 }),
    geofenceOk: boolean("geofence_ok").notNull(),
    speedKmh: numeric("speed_kmh", { precision: 12, scale: 2 }),
    livenessOk: boolean("liveness_ok"),
    mockLocationFlag: boolean("mock_location_flag").notNull().default(false),
    selfieStorageKey: text("selfie_storage_key"),
    reviewStatus: text("review_status").notNull(),
    reviewReasonsJson: jsonb("review_reasons_json").notNull().default(sql`'[]'::jsonb`),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("att_clock_events_idempotency_key").on(table.tenantId, table.idempotencyKey),
    index("att_clock_events_employee_captured_idx").on(
      table.tenantId,
      table.employeeId,
      table.capturedAt,
    ),
  ],
);
