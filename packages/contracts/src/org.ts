import type { FieldIssue } from "./envelope.ts";
import type { PermissionAtom } from "./permissions.ts";

/** IANA zones for WIB, WITA, and WIT. The labels live in the onboarding form. */
export const branchTimezones = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"] as const;

export type BranchTimezone = (typeof branchTimezones)[number];

const timezoneSet: ReadonlySet<string> = new Set(branchTimezones);

export function isBranchTimezone(value: string): value is BranchTimezone {
  return timezoneSet.has(value);
}

/** Roles that can create or change a legal entity or a branch. */
export const orgWriterRoles = ["org_owner", "hr_admin"] as const;

const orgWriterRoleSet: ReadonlySet<string> = new Set(orgWriterRoles);

export function canWriteOrg(role: string): boolean {
  return orgWriterRoleSet.has(role);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type ParseObjectResult<T> = { ok: true; value: T } | { ok: false; fields: FieldIssue[] };

export interface LegalEntityInput {
  companyName: string;
  npwp16: string;
  jkkRiskClass: number | null;
  bpjsBuCode: string | null;
}

export interface LegalEntityPatch {
  companyName?: string;
  npwp16?: string;
  jkkRiskClass?: number | null;
  bpjsBuCode?: string | null;
}

export interface LegalEntityRecord {
  id: string;
  companyName: string;
  npwp16: string;
  jkkRiskClass: number | null;
  bpjsBuCode: string | null;
}

export interface BranchInput {
  legalEntityId: string;
  name: string;
  nitku22: string;
  timezone: BranchTimezone;
  umpUmkIdr: bigint;
  latitude: string | null;
  longitude: string | null;
  geofenceRadiusM: number | null;
}

export type BranchDraft = Omit<BranchInput, "legalEntityId">;

export interface BranchPatch {
  legalEntityId?: string;
  name?: string;
  nitku22?: string;
  timezone?: BranchTimezone;
  umpUmkIdr?: bigint;
  latitude?: string | null;
  longitude?: string | null;
  geofenceRadiusM?: number | null;
}

export interface BranchRecord {
  id: string;
  legalEntityId: string;
  name: string;
  nitku22: string;
  timezone: BranchTimezone;
  umpUmkIdr: string;
  latitude: string | null;
  longitude: string | null;
  geofenceRadiusM: number | null;
}

export interface MeContext {
  user: { id: string; email: string; displayName: string };
  tenant: { id: string; name: string; slug: string; status: "active" | "suspended" };
  role: string;
  permissions: PermissionAtom[];
  scope: {
    legalEntityIds: string[];
    branchIds: string[];
    directReportsOnly: boolean;
    selfOnly: boolean;
  };
  legalEntities: LegalEntityRecord[];
  branches: BranchRecord[];
}

const NPWP_MESSAGE = "NPWP must be 16 digits.";
const NITKU_MESSAGE = "NITKU must be 22 digits.";
const UMP_MESSAGE = "UMP/UMK must be a whole number of rupiah.";
const TIMEZONE_MESSAGE = "Choose a timezone: WIB, WITA, or WIT.";
const MAX_INT8 = 9223372036854775807n;
const MAX_RADIUS = 2_000_000_000;

/** JSON has no bigint. Integer rupiah crosses the boundary as a decimal string. */
export function idrToJson(value: bigint): string {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("IDR values are non-negative bigint rupiah.");
  }
  return value.toString();
}

export function parseNpwp16(input: unknown): ParseResult<string> {
  if (typeof input !== "string" || !/^[0-9]{16}$/u.test(input.trim())) {
    return { ok: false, message: NPWP_MESSAGE };
  }
  return { ok: true, value: input.trim() };
}

export function parseNitku22(input: unknown): ParseResult<string> {
  if (typeof input !== "string" || !/^[0-9]{22}$/u.test(input.trim())) {
    return { ok: false, message: NITKU_MESSAGE };
  }
  return { ok: true, value: input.trim() };
}

/**
 * Accepts a JSON integer, a digit string, or Indonesian thousands dots (`5.396.761`).
 * A fractional rupiah amount is rejected. The stored value is integer bigint.
 */
export function parseUmpIdr(input: unknown): ParseResult<bigint> {
  if (typeof input === "bigint") return finishUmp(input);
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input)) return { ok: false, message: UMP_MESSAGE };
    return finishUmp(BigInt(input));
  }
  if (typeof input === "string") {
    const trimmed = input.trim().replace(/\s+/gu, "");
    const grouped = /^[1-9]\d{0,2}(?:\.\d{3})+$/u.test(trimmed);
    const plain = /^(?:0|[1-9]\d*)$/u.test(trimmed);
    if (!grouped && !plain) return { ok: false, message: UMP_MESSAGE };
    const digits = grouped ? trimmed.replace(/\./gu, "") : trimmed;
    return finishUmp(BigInt(digits));
  }
  return { ok: false, message: UMP_MESSAGE };
}

export function parseLegalEntityCreate(input: unknown): ParseObjectResult<LegalEntityInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const companyName = readName(body.companyName, 160, "Enter the company name.");
  if (!companyName.ok) fields.push({ field: "companyName", message: companyName.message });
  const npwp16 = parseNpwp16(body.npwp16);
  if (!npwp16.ok) fields.push({ field: "npwp16", message: npwp16.message });
  const jkkRiskClass = parseJkk(body.jkkRiskClass);
  if (!jkkRiskClass.ok) fields.push({ field: "jkkRiskClass", message: jkkRiskClass.message });
  const bpjsBuCode = parseBpjs(body.bpjsBuCode);
  if (!bpjsBuCode.ok) fields.push({ field: "bpjsBuCode", message: bpjsBuCode.message });
  if (fields.length > 0 || !companyName.ok || !npwp16.ok || !jkkRiskClass.ok || !bpjsBuCode.ok) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      companyName: companyName.value,
      npwp16: npwp16.value,
      jkkRiskClass: jkkRiskClass.value,
      bpjsBuCode: bpjsBuCode.value,
    },
  };
}

export function parseLegalEntityPatch(input: unknown): ParseObjectResult<LegalEntityPatch> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const value: LegalEntityPatch = {};
  let changed = false;
  if (hasOwn(body, "companyName")) {
    changed = true;
    const companyName = readName(body.companyName, 160, "Enter the company name.");
    if (!companyName.ok) fields.push({ field: "companyName", message: companyName.message });
    else value.companyName = companyName.value;
  }
  if (hasOwn(body, "npwp16")) {
    changed = true;
    const npwp16 = parseNpwp16(body.npwp16);
    if (!npwp16.ok) fields.push({ field: "npwp16", message: npwp16.message });
    else value.npwp16 = npwp16.value;
  }
  if (hasOwn(body, "jkkRiskClass")) {
    changed = true;
    const jkkRiskClass = parseJkk(body.jkkRiskClass);
    if (!jkkRiskClass.ok) fields.push({ field: "jkkRiskClass", message: jkkRiskClass.message });
    else value.jkkRiskClass = jkkRiskClass.value;
  }
  if (hasOwn(body, "bpjsBuCode")) {
    changed = true;
    const bpjsBuCode = parseBpjs(body.bpjsBuCode);
    if (!bpjsBuCode.ok) fields.push({ field: "bpjsBuCode", message: bpjsBuCode.message });
    else value.bpjsBuCode = bpjsBuCode.value;
  }
  if (fields.length > 0) return { ok: false, fields };
  if (!changed) return { ok: false, fields: [{ field: "body", message: "No changes to save." }] };
  return { ok: true, value };
}

export function parseBranchCreate(input: unknown): ParseObjectResult<BranchInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const parsed = parseBranchDraft(input);
  const legalEntityId = parseUuid(body.legalEntityId, "Choose a legal entity.");
  const fields = parsed.ok ? [] : parsed.fields.slice();
  if (!legalEntityId.ok) fields.push({ field: "legalEntityId", message: legalEntityId.message });
  if (!parsed.ok || !legalEntityId.ok) return { ok: false, fields };
  return { ok: true, value: { ...parsed.value, legalEntityId: legalEntityId.value } };
}

/** Branch fields without a legal entity id. The setup form uses this before the entity exists. */
export function parseBranchDraft(input: unknown): ParseObjectResult<BranchDraft> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const name = readName(body.name, 120, "Enter the branch name.");
  if (!name.ok) fields.push({ field: "name", message: name.message });
  const nitku22 = parseNitku22(body.nitku22);
  if (!nitku22.ok) fields.push({ field: "nitku22", message: nitku22.message });
  const timezone = parseTimezone(body.timezone);
  if (!timezone.ok) fields.push({ field: "timezone", message: timezone.message });
  const umpUmkIdr = parseUmpIdr(body.umpUmkIdr);
  if (!umpUmkIdr.ok) fields.push({ field: "umpUmkIdr", message: umpUmkIdr.message });
  const geofence = parseGeofence(body.latitude, body.longitude, body.geofenceRadiusM);
  fields.push(...geofence.fields);
  if (
    fields.length > 0 ||
    !name.ok ||
    !nitku22.ok ||
    !timezone.ok ||
    !umpUmkIdr.ok ||
    !geofence.ok
  ) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      name: name.value,
      nitku22: nitku22.value,
      timezone: timezone.value,
      umpUmkIdr: umpUmkIdr.value,
      latitude: geofence.value.latitude,
      longitude: geofence.value.longitude,
      geofenceRadiusM: geofence.value.geofenceRadiusM,
    },
  };
}

export function parseBranchPatch(input: unknown): ParseObjectResult<BranchPatch> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const value: BranchPatch = {};
  let changed = false;
  if (hasOwn(body, "legalEntityId")) {
    changed = true;
    const legalEntityId = parseUuid(body.legalEntityId, "Choose a legal entity.");
    if (!legalEntityId.ok) fields.push({ field: "legalEntityId", message: legalEntityId.message });
    else value.legalEntityId = legalEntityId.value;
  }
  if (hasOwn(body, "name")) {
    changed = true;
    const name = readName(body.name, 120, "Enter the branch name.");
    if (!name.ok) fields.push({ field: "name", message: name.message });
    else value.name = name.value;
  }
  if (hasOwn(body, "nitku22")) {
    changed = true;
    const nitku22 = parseNitku22(body.nitku22);
    if (!nitku22.ok) fields.push({ field: "nitku22", message: nitku22.message });
    else value.nitku22 = nitku22.value;
  }
  if (hasOwn(body, "timezone")) {
    changed = true;
    const timezone = parseTimezone(body.timezone);
    if (!timezone.ok) fields.push({ field: "timezone", message: timezone.message });
    else value.timezone = timezone.value;
  }
  if (hasOwn(body, "umpUmkIdr")) {
    changed = true;
    const umpUmkIdr = parseUmpIdr(body.umpUmkIdr);
    if (!umpUmkIdr.ok) fields.push({ field: "umpUmkIdr", message: umpUmkIdr.message });
    else value.umpUmkIdr = umpUmkIdr.value;
  }
  const geofenceKeys = ["latitude", "longitude", "geofenceRadiusM"] as const;
  const geofenceTouched = geofenceKeys.some((key) => hasOwn(body, key));
  if (geofenceTouched) {
    changed = true;
    const geofence = parseGeofence(
      hasOwn(body, "latitude") ? body.latitude : null,
      hasOwn(body, "longitude") ? body.longitude : null,
      hasOwn(body, "geofenceRadiusM") ? body.geofenceRadiusM : null,
    );
    if (!geofence.ok) fields.push(...geofence.fields);
    else {
      value.latitude = geofence.value.latitude;
      value.longitude = geofence.value.longitude;
      value.geofenceRadiusM = geofence.value.geofenceRadiusM;
    }
  }
  if (fields.length > 0) return { ok: false, fields };
  if (!changed) return { ok: false, fields: [{ field: "body", message: "No changes to save." }] };
  return { ok: true, value };
}

function parseTimezone(value: unknown): ParseResult<BranchTimezone> {
  if (typeof value !== "string" || !isBranchTimezone(value)) {
    return { ok: false, message: TIMEZONE_MESSAGE };
  }
  return { ok: true, value };
}

function finishUmp(value: bigint): ParseResult<bigint> {
  if (value < 0n || value > MAX_INT8) return { ok: false, message: UMP_MESSAGE };
  return { ok: true, value };
}

function parseJkk(value: unknown): ParseResult<number | null> {
  if (isBlank(value)) return { ok: true, value: null };
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-5]$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (number !== 1 && number !== 2 && number !== 3 && number !== 4 && number !== 5) {
    return { ok: false, message: "JKK risk class must be from 1 to 5." };
  }
  return { ok: true, value: number };
}

function parseBpjs(value: unknown): ParseResult<string | null> {
  if (isBlank(value)) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, message: "BPJS company code must be 32 characters or fewer." };
  }
  const code = value.trim();
  if (code.length === 0) return { ok: true, value: null };
  if (code.length > 32 || !/^[A-Za-z0-9.-]+$/u.test(code)) {
    return { ok: false, message: "BPJS company code must be 32 characters or fewer." };
  }
  return { ok: true, value: code };
}

function parseGeofence(
  latitude: unknown,
  longitude: unknown,
  radius: unknown,
): { ok: true; value: Pick<BranchDraft, "latitude" | "longitude" | "geofenceRadiusM">; fields: [] } | {
  ok: false;
  fields: FieldIssue[];
} {
  const latBlank = isBlank(latitude);
  const lngBlank = isBlank(longitude);
  const radiusBlank = isBlank(radius);
  if (latBlank && lngBlank && radiusBlank) {
    return { ok: true, value: { latitude: null, longitude: null, geofenceRadiusM: null }, fields: [] };
  }
  const fields: FieldIssue[] = [];
  let lat: string | null = null;
  let lng: string | null = null;
  let radiusM: number | null = null;
  if (latBlank) fields.push({ field: "latitude", message: "Enter the latitude." });
  else {
    const parsed = parseCoord(latitude, -90, 90, "Latitude must be between -90 and 90.");
    if (!parsed.ok) fields.push({ field: "latitude", message: parsed.message });
    else lat = parsed.value;
  }
  if (lngBlank) fields.push({ field: "longitude", message: "Enter the longitude." });
  else {
    const parsed = parseCoord(longitude, -180, 180, "Longitude must be between -180 and 180.");
    if (!parsed.ok) fields.push({ field: "longitude", message: parsed.message });
    else lng = parsed.value;
  }
  if (radiusBlank) fields.push({ field: "geofenceRadiusM", message: "Enter the radius." });
  else {
    const parsed = parseRadius(radius);
    if (!parsed.ok) fields.push({ field: "geofenceRadiusM", message: parsed.message });
    else radiusM = parsed.value;
  }
  if (fields.length > 0 || lat === null || lng === null || radiusM === null) {
    return { ok: false, fields };
  }
  return { ok: true, value: { latitude: lat, longitude: lng, geofenceRadiusM: radiusM }, fields: [] };
}

function parseCoord(value: unknown, min: number, max: number, message: string): ParseResult<string> {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
  if (text === null || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(text)) {
    return { ok: false, message };
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < min || number > max) return { ok: false, message };
  const canonical = canonicalDecimal(text);
  if (canonical === null) return { ok: false, message };
  return { ok: true, value: canonical };
}

function parseRadius(value: unknown): ParseResult<number> {
  const message = "Radius must be a whole number of meters.";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RADIUS) {
      return { ok: false, message };
    }
    return { ok: true, value };
  }
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
    const number = Number(value.trim());
    if (Number.isSafeInteger(number) && number <= MAX_RADIUS) return { ok: true, value: number };
  }
  return { ok: false, message };
}

function canonicalDecimal(text: string): string | null {
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  if (!whole) return null;
  const fractionCanon = fraction.replace(/0+$/u, "");
  const body = fractionCanon.length > 0 ? `${whole}.${fractionCanon}` : whole;
  if (body === "0") return "0";
  return negative ? `-${body}` : body;
}

function parseUuid(value: unknown, message: string): ParseResult<string> {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    return { ok: false, message };
  }
  return { ok: true, value: value.toLowerCase() };
}

function readName(value: unknown, max: number, emptyMessage: string): ParseResult<string> {
  if (typeof value !== "string") return { ok: false, message: emptyMessage };
  const name = value.trim();
  if (name.length === 0 || hasControlCharacter(name)) {
    return { ok: false, message: emptyMessage };
  }
  if (name.length > max) return { ok: false, message: `Use ${max} characters or fewer.` };
  return { ok: true, value: name };
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(body, key);
}

function objectError(): ParseObjectResult<never> {
  return { ok: false, fields: [{ field: "body", message: "Send a JSON object." }] };
}
