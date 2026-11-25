import type { FieldIssue } from "@gotonghr/contracts";
import { MAX_SYNC_BATCH, SELFIE_MAX_BYTES, type SelfieContentType } from "./limits.ts";
import type { ClockEventInput, SelfieUploadInput } from "./types.ts";
import { isUuidV7 } from "./uuid.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const SELFIE_KEY =
  /^selfies\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$/iu;

const RAW_IMAGE = /selfie|image|photo|blob|bytes/iu;

const EVENT_FIELDS = new Set([
  "idempotencyKey",
  "employeeId",
  "branchId",
  "punchType",
  "capturedAt",
  "syncSource",
  "lat",
  "lng",
  "accuracyMeters",
  "livenessOk",
  "mockLocationFlag",
  "selfieStorageKey",
]);

export type Parsed<T> = { ok: true; value: T } | { ok: false; fields: FieldIssue[] };

export function parseSyncBody(body: unknown, tenantId: string): Parsed<ClockEventInput[]> {
  const fields: FieldIssue[] = [];
  const record = asRecord(body);
  if (!record) return fail([{ field: "body", message: "Send a JSON object." }]);
  rejectRawImage(record, "", fields);
  for (const key of Object.keys(record)) {
    if (key !== "events") fields.push({ field: key, message: "Unknown field." });
  }
  if (!Array.isArray(record.events)) {
    fields.push({ field: "events", message: "Send 1 to 100 clock events." });
  } else if (record.events.length < 1 || record.events.length > MAX_SYNC_BATCH) {
    fields.push({ field: "events", message: "Send 1 to 100 clock events." });
  } else {
    const events: ClockEventInput[] = [];
    for (let index = 0; index < record.events.length; index += 1) {
      const parsed = parseEvent(record.events[index], index, tenantId);
      fields.push(...parsed.fields);
      if (parsed.event) events.push(parsed.event);
    }
    if (fields.length === 0) return { ok: true, value: events };
  }
  return fail(fields);
}

export function parseSelfieUpload(body: unknown): Parsed<SelfieUploadInput> {
  const fields: FieldIssue[] = [];
  const record = asRecord(body);
  if (!record) return fail([{ field: "body", message: "Send a JSON object." }]);
  rejectRawImage(record, "", fields);
  for (const key of Object.keys(record)) {
    if (key !== "contentType" && key !== "contentLength") {
      fields.push({ field: key, message: "Unknown field." });
    }
  }
  const contentType = readContentType(record.contentType, fields);
  const contentLength = readContentLength(record.contentLength, fields);
  if (fields.length > 0 || !contentType || contentLength === null) return fail(fields);
  return { ok: true, value: { contentType, contentLength } };
}

export function isSelfieKey(tenantId: string, key: string): boolean {
  const prefix = `selfies/${tenantId.toLowerCase()}/`;
  return key.toLowerCase().startsWith(prefix) && SELFIE_KEY.test(key);
}

function parseEvent(
  value: unknown,
  index: number,
  tenantId: string,
): { event: ClockEventInput | null; fields: FieldIssue[] } {
  const fields: FieldIssue[] = [];
  const record = asRecord(value);
  const name = (field: string) => `events.${index}.${field}`;
  if (!record) {
    return { event: null, fields: [{ field: `events.${index}`, message: "Send a clock event." }] };
  }
  rejectRawImage(record, `events.${index}.`, fields);
  for (const key of Object.keys(record)) {
    if (!EVENT_FIELDS.has(key)) fields.push({ field: name(key), message: "Unknown field." });
  }
  const idempotencyKey = readUuidV7(record.idempotencyKey, name("idempotencyKey"), fields);
  const employeeId = readUuid(record.employeeId, name("employeeId"), fields);
  const branchId = readOptionalUuid(record.branchId, name("branchId"), fields);
  const punchType = readChoice(record.punchType, ["clock_in", "clock_out"] as const, name("punchType"), fields);
  const capturedAt = readTimestamp(record.capturedAt, name("capturedAt"), fields);
  const syncSource = readChoice(record.syncSource, ["online", "offline_queue"] as const, name("syncSource"), fields);
  const lat = readCoord(record.lat, -90, 90, name("lat"), fields);
  const lng = readCoord(record.lng, -180, 180, name("lng"), fields);
  const accuracyMeters = readOptionalNumber(record.accuracyMeters, 0, 10_000_000, name("accuracyMeters"), fields);
  const livenessOk = readOptionalBoolean(record.livenessOk, name("livenessOk"), fields);
  const mockLocationFlag = readBoolean(record.mockLocationFlag, name("mockLocationFlag"), fields, false);
  const selfieStorageKey = readSelfieKey(record.selfieStorageKey, tenantId, name("selfieStorageKey"), fields);
  if (
    fields.length > 0 ||
    !idempotencyKey ||
    !employeeId ||
    !punchType ||
    !capturedAt ||
    !syncSource ||
    lat === null ||
    lng === null ||
    mockLocationFlag === null
  ) {
    return { event: null, fields };
  }
  return {
    event: {
      idempotencyKey,
      employeeId,
      branchId,
      punchType,
      capturedAt,
      syncSource,
      lat,
      lng,
      accuracyMeters,
      livenessOk,
      mockLocationFlag,
      selfieStorageKey,
    },
    fields,
  };
}

function readContentType(value: unknown, fields: FieldIssue[]): SelfieContentType | null {
  if (typeof value !== "string") {
    fields.push({ field: "contentType", message: "Use image/webp or image/jpeg." });
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "image/webp" && normalized !== "image/jpeg") {
    fields.push({ field: "contentType", message: "Use image/webp or image/jpeg." });
    return null;
  }
  return normalized;
}

function readContentLength(value: unknown, fields: FieldIssue[]): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fields.push({ field: "contentLength", message: "Enter a size in bytes." });
    return null;
  }
  if (value > SELFIE_MAX_BYTES) {
    fields.push({ field: "contentLength", message: "Selfie must be 100 KB or smaller." });
    return null;
  }
  return value;
}

function readSelfieKey(value: unknown, tenantId: string, field: string, fields: FieldIssue[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isSelfieKey(tenantId, value)) {
    fields.push({ field, message: "Send the storage key from the upload URL." });
    return null;
  }
  return value;
}

function readUuidV7(value: unknown, field: string, fields: FieldIssue[]): string | null {
  if (typeof value !== "string" || !isUuidV7(value)) {
    fields.push({ field, message: "Use a UUIDv7." });
    return null;
  }
  return value.toLowerCase();
}

function readUuid(value: unknown, field: string, fields: FieldIssue[]): string | null {
  if (typeof value !== "string" || !UUID.test(value)) {
    fields.push({ field, message: "Use a UUID." });
    return null;
  }
  return value.toLowerCase();
}

function readOptionalUuid(value: unknown, field: string, fields: FieldIssue[]): string | null {
  if (value === undefined || value === null) return null;
  return readUuid(value, field, fields);
}

function readChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fields: FieldIssue[],
): T | null {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fields.push({ field, message: `Use ${allowed.join(" or ")}.` });
    return null;
  }
  return value as T;
}

function readTimestamp(value: unknown, field: string, fields: FieldIssue[]): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    fields.push({ field, message: "Use an ISO timestamp." });
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fields.push({ field, message: "Use an ISO timestamp." });
    return null;
  }
  return parsed;
}

function readCoord(
  value: unknown,
  min: number,
  max: number,
  field: string,
  fields: FieldIssue[],
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fields.push({ field, message: `Enter a number from ${min} to ${max}.` });
    return null;
  }
  return value;
}

function readOptionalNumber(
  value: unknown,
  min: number,
  max: number,
  field: string,
  fields: FieldIssue[],
): number | null {
  if (value === undefined || value === null) return null;
  return readCoord(value, min, max, field, fields);
}

function readOptionalBoolean(value: unknown, field: string, fields: FieldIssue[]): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    fields.push({ field, message: "Use true or false." });
    return null;
  }
  return value;
}

function readBoolean(
  value: unknown,
  field: string,
  fields: FieldIssue[],
  fallback: boolean,
): boolean | null {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    fields.push({ field, message: "Use true or false." });
    return null;
  }
  return value;
}

function rejectRawImage(record: Record<string, unknown>, prefix: string, fields: FieldIssue[]): void {
  for (const key of Object.keys(record)) {
    if (key === "selfieStorageKey") continue;
    if (!RAW_IMAGE.test(key)) continue;
    fields.push({ field: `${prefix}${key}`, message: "Send a storage key, not the selfie bytes." });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function fail(fields: FieldIssue[]): Parsed<never> {
  return { ok: false, fields };
}
