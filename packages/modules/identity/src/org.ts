import {
  idrToJson,
  isBranchTimezone,
  type BranchInput,
  type BranchPatch,
  type BranchRecord,
  type FieldIssue,
  type LegalEntityInput,
  type LegalEntityPatch,
  type LegalEntityRecord,
  type MeContext,
} from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import type { GotongAuthContext } from "./guard.ts";

export class OrgFieldError extends Error {
  readonly fields: FieldIssue[];

  constructor(fields: FieldIssue[]) {
    super("Check the highlighted fields.");
    this.name = "OrgFieldError";
    this.fields = fields;
  }
}

export class OrgNotFoundError extends Error {
  constructor() {
    super("That record was not found.");
    this.name = "OrgNotFoundError";
  }
}

export class OrgConflictError extends Error {
  readonly fields: FieldIssue[];

  constructor(fields: FieldIssue[]) {
    super("That value is already used.");
    this.name = "OrgConflictError";
    this.fields = fields;
  }
}

export class OrgForbiddenError extends Error {
  constructor() {
    super("That record is outside your scope.");
    this.name = "OrgForbiddenError";
  }
}

const entityColumns = sql`id, company_name, npwp_16, jkk_risk_class, bpjs_bu_code`;
const branchColumns = sql`
  id,
  legal_entity_id,
  name,
  nitku_22,
  timezone,
  ump_umk_idr::text AS ump_umk_idr,
  geofence_lat::text AS geofence_lat,
  geofence_lng::text AS geofence_lng,
  geofence_radius_m
`;

export async function loadContext(appDb: TenantDatabase, auth: GotongAuthContext): Promise<MeContext> {
  const profile = await appDb.withTenantContext(auth.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT u.display_name, t.name AS tenant_name, t.slug, t.status
      FROM id_users AS u
      JOIN id_tenants AS t ON t.id = u.tenant_id
      WHERE u.id = ${auth.userId}::uuid
    `);
    return result.rows[0];
  });
  const row = asRecord(profile);
  if (!row) throw new Error("Membership profile is missing.");
  const [legalEntities, branches] = await Promise.all([
    listLegalEntities(appDb, auth),
    listBranches(appDb, auth),
  ]);
  return {
    user: {
      id: auth.userId,
      email: auth.email,
      displayName: requiredText(row, "display_name"),
    },
    tenant: {
      id: auth.tenantId,
      name: requiredText(row, "tenant_name"),
      slug: requiredText(row, "slug"),
      status: readStatus(requiredText(row, "status")),
    },
    role: auth.role,
    permissions: [...auth.permissions],
    scope: {
      legalEntityIds: [...auth.scopeEntityIds],
      branchIds: [...auth.scopeBranchIds],
      directReportsOnly: auth.directReportsOnly,
      selfOnly: auth.selfOnly,
    },
    legalEntities,
    branches,
  };
}

export async function listLegalEntities(
  appDb: TenantDatabase,
  auth: GotongAuthContext,
): Promise<LegalEntityRecord[]> {
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT ${entityColumns}
      FROM id_legal_entities
      ORDER BY created_at, id
    `);
    const owners = await branchScopeEntityIds(tx, auth);
    return result.rows
      .map(readLegalEntity)
      .filter((entity) => entityVisible(auth, entity.id, owners));
  });
}

export async function createLegalEntity(
  appDb: TenantDatabase,
  auth: GotongAuthContext,
  input: LegalEntityInput,
): Promise<LegalEntityRecord> {
  if (auth.scopeEntityIds.length > 0 || auth.scopeBranchIds.length > 0) throw new OrgForbiddenError();
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    try {
      const result = await tx.execute(sql`
        INSERT INTO id_legal_entities (
          tenant_id, company_name, npwp_16, jkk_risk_class, bpjs_bu_code
        )
        VALUES (
          ${auth.tenantId}::uuid,
          ${input.companyName},
          ${input.npwp16},
          ${input.jkkRiskClass},
          ${input.bpjsBuCode}
        )
        RETURNING ${entityColumns}
      `);
      const row = result.rows[0];
      if (!row) throw new Error("Legal entity insert returned no row.");
      return readLegalEntity(row);
    } catch (error) {
      rethrowOrg(error);
    }
  });
}

export async function updateLegalEntity(
  appDb: TenantDatabase,
  auth: GotongAuthContext,
  id: string,
  patch: LegalEntityPatch,
): Promise<LegalEntityRecord> {
  if (auth.scopeBranchIds.length > 0) throw new OrgForbiddenError();
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const current = await findLegalEntity(tx, id);
    if (!current || !entityVisible(auth, current.id, null)) throw new OrgNotFoundError();
    const next: LegalEntityInput = {
      companyName: patch.companyName ?? current.companyName,
      npwp16: patch.npwp16 ?? current.npwp16,
      jkkRiskClass: patch.jkkRiskClass === undefined ? current.jkkRiskClass : patch.jkkRiskClass,
      bpjsBuCode: patch.bpjsBuCode === undefined ? current.bpjsBuCode : patch.bpjsBuCode,
    };
    try {
      const result = await tx.execute(sql`
        UPDATE id_legal_entities
        SET company_name = ${next.companyName},
            npwp_16 = ${next.npwp16},
            jkk_risk_class = ${next.jkkRiskClass},
            bpjs_bu_code = ${next.bpjsBuCode},
            updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING ${entityColumns}
      `);
      const row = result.rows[0];
      if (!row) throw new OrgNotFoundError();
      return readLegalEntity(row);
    } catch (error) {
      if (error instanceof OrgNotFoundError) throw error;
      rethrowOrg(error);
    }
  });
}

export async function listBranches(
  appDb: TenantDatabase,
  auth: GotongAuthContext,
): Promise<BranchRecord[]> {
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT ${branchColumns}
      FROM id_branches
      ORDER BY created_at, id
    `);
    return result.rows.map(readBranch).filter((branch) => branchVisible(auth, branch));
  });
}

export async function createBranch(
  appDb: TenantDatabase,
  auth: GotongAuthContext,
  input: BranchInput,
): Promise<BranchRecord> {
  if (auth.scopeBranchIds.length > 0) throw new OrgForbiddenError();
  assertGeofence(input);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const entity = await findLegalEntity(tx, input.legalEntityId);
    if (!entity || !entityVisible(auth, entity.id, null)) {
      throw new OrgFieldError([{ field: "legalEntityId", message: "Choose a legal entity." }]);
    }
    try {
      const result = await tx.execute(sql`
        INSERT INTO id_branches (
          tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr,
          geofence_lat, geofence_lng, geofence_radius_m
        )
        VALUES (
          ${auth.tenantId}::uuid,
          ${input.legalEntityId}::uuid,
          ${input.name},
          ${input.nitku22},
          ${input.timezone},
          ${idrToJson(input.umpUmkIdr)}::bigint,
          ${input.latitude}::numeric,
          ${input.longitude}::numeric,
          ${input.geofenceRadiusM}
        )
        RETURNING ${branchColumns}
      `);
      const row = result.rows[0];
      if (!row) throw new Error("Branch insert returned no row.");
      return readBranch(row);
    } catch (error) {
      if (error instanceof OrgFieldError) throw error;
      rethrowOrg(error);
    }
  });
}

export async function updateBranch(
  appDb: TenantDatabase,
  auth: GotongAuthContext,
  id: string,
  patch: BranchPatch,
): Promise<BranchRecord> {
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const current = await findBranch(tx, id);
    if (!current || !branchVisible(auth, current)) throw new OrgNotFoundError();
    const next: BranchInput = {
      legalEntityId: patch.legalEntityId ?? current.legalEntityId,
      name: patch.name ?? current.name,
      nitku22: patch.nitku22 ?? current.nitku22,
      timezone: patch.timezone ?? current.timezone,
      umpUmkIdr: patch.umpUmkIdr === undefined ? BigInt(current.umpUmkIdr) : patch.umpUmkIdr,
      latitude: patch.latitude === undefined ? current.latitude : patch.latitude,
      longitude: patch.longitude === undefined ? current.longitude : patch.longitude,
      geofenceRadiusM:
        patch.geofenceRadiusM === undefined ? current.geofenceRadiusM : patch.geofenceRadiusM,
    };
    assertGeofence(next);
    if (next.legalEntityId !== current.legalEntityId) {
      const owners = await branchScopeEntityIds(tx, auth);
      const entity = await findLegalEntity(tx, next.legalEntityId);
      if (!entity || !entityVisible(auth, entity.id, owners)) {
        throw new OrgFieldError([{ field: "legalEntityId", message: "Choose a legal entity." }]);
      }
    }
    try {
      const result = await tx.execute(sql`
        UPDATE id_branches
        SET legal_entity_id = ${next.legalEntityId}::uuid,
            name = ${next.name},
            nitku_22 = ${next.nitku22},
            timezone = ${next.timezone},
            ump_umk_idr = ${idrToJson(next.umpUmkIdr)}::bigint,
            geofence_lat = ${next.latitude}::numeric,
            geofence_lng = ${next.longitude}::numeric,
            geofence_radius_m = ${next.geofenceRadiusM},
            updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING ${branchColumns}
      `);
      const row = result.rows[0];
      if (!row) throw new OrgNotFoundError();
      return readBranch(row);
    } catch (error) {
      if (error instanceof OrgNotFoundError || error instanceof OrgFieldError) throw error;
      rethrowOrg(error);
    }
  });
}

async function findLegalEntity(tx: TenantTx, id: string): Promise<LegalEntityRecord | null> {
  const result = await tx.execute(sql`
    SELECT ${entityColumns}
    FROM id_legal_entities
    WHERE id = ${id}::uuid
  `);
  const row = result.rows[0];
  return row ? readLegalEntity(row) : null;
}

async function findBranch(tx: TenantTx, id: string): Promise<BranchRecord | null> {
  const result = await tx.execute(sql`
    SELECT ${branchColumns}
    FROM id_branches
    WHERE id = ${id}::uuid
  `);
  const row = result.rows[0];
  return row ? readBranch(row) : null;
}

/**
 * A non-empty branch scope is not "see every legal entity".
 * Those users only read entities that own one of their branches, and they cannot write an entity.
 */
function entityVisible(
  auth: GotongAuthContext,
  id: string,
  branchOwnerIds: ReadonlySet<string> | null,
): boolean {
  if (auth.scopeEntityIds.length > 0 && !auth.scopeEntityIds.includes(id)) return false;
  if (auth.scopeBranchIds.length === 0) return true;
  return branchOwnerIds?.has(id) ?? false;
}

function branchVisible(auth: GotongAuthContext, branch: BranchRecord): boolean {
  const entityOk = auth.scopeEntityIds.length === 0 || auth.scopeEntityIds.includes(branch.legalEntityId);
  const branchOk = auth.scopeBranchIds.length === 0 || auth.scopeBranchIds.includes(branch.id);
  return entityOk && branchOk;
}

async function branchScopeEntityIds(
  tx: TenantTx,
  auth: GotongAuthContext,
): Promise<ReadonlySet<string> | null> {
  if (auth.scopeBranchIds.length === 0) return null;
  const result = await tx.execute(sql`SELECT id, legal_entity_id FROM id_branches`);
  const allowed = new Set(auth.scopeBranchIds);
  const owners = new Set<string>();
  for (const row of result.rows) {
    const record = asRecord(row);
    if (!record) continue;
    const id = requiredText(record, "id");
    if (!allowed.has(id)) continue;
    owners.add(requiredText(record, "legal_entity_id"));
  }
  return owners;
}

function assertGeofence(input: Pick<BranchInput, "latitude" | "longitude" | "geofenceRadiusM">): void {
  const present = [input.latitude, input.longitude, input.geofenceRadiusM].filter((value) => value !== null);
  if (present.length === 0 || present.length === 3) return;
  throw new OrgFieldError([
    { field: "latitude", message: "Enter latitude, longitude, and radius together." },
  ]);
}

function readLegalEntity(row: unknown): LegalEntityRecord {
  const record = asRecord(row);
  if (!record) throw new Error("Expected a legal entity row.");
  return {
    id: requiredText(record, "id"),
    companyName: requiredText(record, "company_name"),
    npwp16: requiredText(record, "npwp_16"),
    jkkRiskClass: readJkk(record.jkk_risk_class),
    bpjsBuCode: optionalText(record, "bpjs_bu_code"),
  };
}

function readBranch(row: unknown): BranchRecord {
  const record = asRecord(row);
  if (!record) throw new Error("Expected a branch row.");
  const timezone = requiredText(record, "timezone");
  if (!isBranchTimezone(timezone)) throw new Error("Stored timezone is invalid.");
  return {
    id: requiredText(record, "id"),
    legalEntityId: requiredText(record, "legal_entity_id"),
    name: requiredText(record, "name"),
    nitku22: requiredText(record, "nitku_22"),
    timezone,
    umpUmkIdr: requiredText(record, "ump_umk_idr"),
    latitude: coordOrNull(record, "geofence_lat"),
    longitude: coordOrNull(record, "geofence_lng"),
    geofenceRadiusM: readRadius(record.geofence_radius_m),
  };
}

function readStatus(value: string): "active" | "suspended" {
  if (value === "active" || value === "suspended") return value;
  throw new Error("Stored tenant status is invalid.");
}

function readJkk(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number)) throw new Error("Stored JKK class is invalid.");
  return number;
}

function readRadius(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number)) throw new Error("Stored radius is invalid.");
  return number;
}

function coordOrNull(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : null;
  if (!text) throw new Error(`Expected ${key} to be numeric.`);
  return stripNumeric(text);
}

function stripNumeric(text: string): string {
  if (!text.includes(".")) return text;
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const fractionCanon = fraction.replace(/0+$/u, "");
  const body = fractionCanon.length > 0 ? `${whole ?? ""}.${fractionCanon}` : (whole ?? "");
  if (body === "0") return "0";
  return negative ? `-${body}` : body;
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be text.`);
  }
  return value;
}

function optionalText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Expected ${key} to be text.`);
  return value;
}

function asRecord(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

function rethrowOrg(error: unknown): never {
  const code = errorCode(error);
  const constraint = errorConstraint(error);
  if (code === "23505") {
    if (constraint.includes("npwp")) {
      throw new OrgConflictError([{ field: "npwp16", message: "This NPWP is already used." }]);
    }
    if (constraint.includes("nitku")) {
      throw new OrgConflictError([{ field: "nitku22", message: "This NITKU is already used." }]);
    }
    throw new OrgConflictError([{ field: "body", message: "That value is already used." }]);
  }
  if (code === "23503") {
    throw new OrgFieldError([{ field: "legalEntityId", message: "Choose a legal entity." }]);
  }
  if (code === "23514") throw new OrgFieldError(checkFields(constraint));
  throw error;
}

function checkFields(constraint: string): FieldIssue[] {
  if (constraint.includes("company_name")) {
    return [{ field: "companyName", message: "Enter the company name." }];
  }
  if (constraint.includes("npwp")) return [{ field: "npwp16", message: "NPWP must be 16 digits." }];
  if (constraint.includes("nitku")) return [{ field: "nitku22", message: "NITKU must be 22 digits." }];
  if (constraint.includes("timezone")) {
    return [{ field: "timezone", message: "Choose a timezone: WIB, WITA, or WIT." }];
  }
  if (constraint.includes("ump")) {
    return [{ field: "umpUmkIdr", message: "UMP/UMK must be a whole number of rupiah." }];
  }
  if (constraint.includes("geofence") || constraint.includes("_lat") || constraint.includes("_lng")) {
    return [{ field: "latitude", message: "Enter latitude, longitude, and radius together." }];
  }
  if (constraint.includes("name")) return [{ field: "name", message: "Enter the branch name." }];
  return [{ field: "body", message: "A value does not match the company rules." }];
}

function causes(error: unknown): object[] {
  const found: object[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    found.push(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return found;
}

function errorCode(error: unknown): string | undefined {
  for (const item of causes(error)) {
    if ("code" in item && typeof item.code === "string") return item.code;
  }
  return undefined;
}

function errorConstraint(error: unknown): string {
  for (const item of causes(error)) {
    if ("constraint" in item && typeof item.constraint === "string") return item.constraint;
  }
  return "";
}
