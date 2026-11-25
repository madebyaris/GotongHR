import { createHash, timingSafeEqual } from "node:crypto";
import {
  fail,
  idr,
  ok,
  ptkpStatuses,
  type AttendancePayrollPort,
  type AttendancePeriodSummaryDTO,
  type CoreHrPayrollPort,
  type EmployeePayrollProfileDTO,
  type StatutoryPayrollPort,
} from "@gotonghr/contracts";
import { TENANT_HEADER } from "@gotonghr/identity";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PayrollPortName, PortUrls } from "../config.ts";

export const INTERNAL_SECRET_HEADER = "x-gotong-internal-secret";

/** Sentinel tenant for the published statutory read. The table has no tenant. */
export const STATUTORY_PORT_TENANT = "00000000-0000-7000-8000-000000000001";

export const portPaths = {
  payrollProfiles: "/internal/ports/core-hr/payroll-profiles",
  employeeForUser: "/internal/ports/core-hr/employee-for-user",
  periodSummaries: "/internal/ports/attendance/period-summaries",
  attachRun: "/internal/ports/attendance/attach-run",
  effectiveTable: "/internal/ports/statutory/effective-table",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const taxMethods = ["gross", "nett", "gross_up"] as const;
const subjects = ["permanent", "non_permanent", "expat"] as const;

export interface PayrollPortAdapters {
  coreHr: CoreHrPayrollPort;
  attendance: AttendancePayrollPort;
  statutory: StatutoryPayrollPort;
}

export interface HttpPayrollPortOptions {
  secret: string;
  urls: PortUrls;
  fetchImpl?: typeof fetch;
}

export function createHttpPayrollPorts(options: HttpPayrollPortOptions): PayrollPortAdapters {
  const fetchImpl = options.fetchImpl ?? fetch;
  const secret = options.secret;
  return {
    coreHr: {
      async getActivePayrollProfiles(input) {
        const data = await postPort(
          fetchImpl,
          options.urls.coreHr,
          portPaths.payrollProfiles,
          secret,
          input.tenantId,
          {
            legalEntityId: input.legalEntityId,
            periodYear: input.periodYear,
            periodMonth: input.periodMonth,
          },
        );
        if (!Array.isArray(data)) throw new Error("core-hr port returned no profile list");
        return data.map((row) => profileFromJson(row));
      },
      async employeeIdForUser(input) {
        const data = await postPort(
          fetchImpl,
          options.urls.coreHr,
          portPaths.employeeForUser,
          secret,
          input.tenantId,
          { userId: input.userId },
        );
        const record = asRecord(data);
        if (!record || !("employeeId" in record)) throw new Error("core-hr port returned no employee id");
        if (record.employeeId === null) return null;
        if (typeof record.employeeId !== "string" || !UUID.test(record.employeeId)) {
          throw new Error("core-hr port returned a bad employee id");
        }
        return record.employeeId;
      },
    },
    attendance: {
      async getLockedPeriodSummaries(input) {
        const data = await postPort(
          fetchImpl,
          options.urls.attendance,
          portPaths.periodSummaries,
          secret,
          input.tenantId,
          {
            legalEntityId: input.legalEntityId,
            periodYear: input.periodYear,
            periodMonth: input.periodMonth,
          },
        );
        if (!Array.isArray(data)) throw new Error("attendance port returned no summary list");
        return data.map((row) => summaryFromJson(row));
      },
      async attachPayrollRun(input) {
        const data = await postPort(
          fetchImpl,
          options.urls.attendance,
          portPaths.attachRun,
          secret,
          input.tenantId,
          {
            legalEntityId: input.legalEntityId,
            periodYear: input.periodYear,
            periodMonth: input.periodMonth,
            runId: input.runId,
          },
        );
        const record = asRecord(data);
        const attached = record?.attached;
        if (typeof attached !== "number" || !Number.isInteger(attached) || attached < 0) {
          throw new Error("attendance port returned a bad attach count");
        }
        return { attached };
      },
    },
    statutory: {
      async getEffectiveTable(input) {
        const data = await postPort(
          fetchImpl,
          options.urls.statutory,
          portPaths.effectiveTable,
          secret,
          STATUTORY_PORT_TENANT,
          { payrollDate: input.payrollDate },
        );
        if (data === null) return null;
        const record = asRecord(data);
        if (!record || typeof record.id !== "string" || !UUID.test(record.id) || !("payload" in record)) {
          throw new Error("statutory port returned a bad table");
        }
        return { id: record.id, payload: record.payload };
      },
    },
  };
}

export async function registerInternalPortRoutes(
  app: FastifyInstance,
  options: { secret: string; ports: readonly PayrollPortName[]; adapters: PayrollPortAdapters },
): Promise<void> {
  const owned = new Set(options.ports);
  if (owned.has("core-hr")) {
    app.post(portPaths.payrollProfiles, async (request, reply) => {
      const tenantId = await authorize(options.secret, request, reply);
      if (!tenantId) return;
      const body = await readPeriodBody(request.body, reply);
      if (!body) return;
      const profiles = await options.adapters.coreHr.getActivePayrollProfiles({ tenantId, ...body });
      note("core-hr", "payroll-profiles");
      return reply.send(ok(profiles.map((profile) => profileToJson(profile))));
    });
    app.post(portPaths.employeeForUser, async (request, reply) => {
      const tenantId = await authorize(options.secret, request, reply);
      if (!tenantId) return;
      const userId = await readUuidField(request.body, "userId", reply);
      if (!userId) return;
      const employeeId = await options.adapters.coreHr.employeeIdForUser({ tenantId, userId });
      note("core-hr", "employee-for-user");
      return reply.send(ok({ employeeId }));
    });
  }
  if (owned.has("attendance")) {
    app.post(portPaths.periodSummaries, async (request, reply) => {
      const tenantId = await authorize(options.secret, request, reply);
      if (!tenantId) return;
      const body = await readPeriodBody(request.body, reply);
      if (!body) return;
      const summaries = await options.adapters.attendance.getLockedPeriodSummaries({ tenantId, ...body });
      note("attendance", "period-summaries");
      return reply.send(ok(summaries));
    });
    app.post(portPaths.attachRun, async (request, reply) => {
      const tenantId = await authorize(options.secret, request, reply);
      if (!tenantId) return;
      const body = await readPeriodBody(request.body, reply);
      if (!body) return;
      const runId = await readUuidField(request.body, "runId", reply);
      if (!runId) return;
      const result = await options.adapters.attendance.attachPayrollRun({ tenantId, ...body, runId });
      note("attendance", "attach-run");
      return reply.send(ok(result));
    });
  }
  if (owned.has("statutory")) {
    app.post(portPaths.effectiveTable, async (request, reply) => {
      const tenantId = await authorize(options.secret, request, reply);
      if (!tenantId) return;
      const record = asRecord(request.body);
      const payrollDate = record?.payrollDate;
      if (typeof payrollDate !== "string" || !ISO_DATE.test(payrollDate)) {
        return reply.code(400).send(fail("invalid_field", "payrollDate must be YYYY-MM-DD."));
      }
      const table = await options.adapters.statutory.getEffectiveTable({ payrollDate });
      note("statutory", "effective-table");
      return reply.send(ok(table));
    });
  }
}

export function profileToJson(profile: EmployeePayrollProfileDTO): Record<string, unknown> {
  return {
    ...profile,
    baseSalaryIdr: profile.baseSalaryIdr.toString(),
    fixedAllowancesIdr: profile.fixedAllowancesIdr.toString(),
    umpUmkIdr: profile.umpUmkIdr.toString(),
  };
}

export function profileFromJson(value: unknown): EmployeePayrollProfileDTO {
  const record = asRecord(value);
  if (!record) throw new Error("core-hr port returned a profile that is not an object");
  const userId = record.userId;
  return {
    tenantId: requiredText(record.tenantId, "tenantId"),
    employeeId: requiredText(record.employeeId, "employeeId"),
    legalEntityId: requiredText(record.legalEntityId, "legalEntityId"),
    branchId: requiredText(record.branchId, "branchId"),
    userId: userId === null ? null : requiredText(userId, "userId"),
    employeeCode: requiredText(record.employeeCode, "employeeCode"),
    fullName: requiredText(record.fullName, "fullName"),
    jobTitle: requiredText(record.jobTitle, "jobTitle"),
    dateOfBirth: requiredText(record.dateOfBirth, "dateOfBirth"),
    ptkpStatus: oneOf(record.ptkpStatus, ptkpStatuses, "ptkpStatus"),
    taxMethod: oneOf(record.taxMethod, taxMethods, "taxMethod"),
    pph21SubjectType: oneOf(record.pph21SubjectType, subjects, "pph21SubjectType"),
    baseSalaryIdr: money(record.baseSalaryIdr, "baseSalaryIdr"),
    fixedAllowancesIdr: money(record.fixedAllowancesIdr, "fixedAllowancesIdr"),
    bpjsFlags: flags(record.bpjsFlags),
    nik: requiredText(record.nik, "nik"),
    bankAccountNumber: requiredText(record.bankAccountNumber, "bankAccountNumber"),
    nitku: requiredText(record.nitku, "nitku"),
    companyName: requiredText(record.companyName, "companyName"),
    companyNpwp: requiredText(record.companyNpwp, "companyNpwp"),
    umpUmkIdr: money(record.umpUmkIdr, "umpUmkIdr"),
    jkkRiskClass: risk(record.jkkRiskClass),
  };
}

function summaryFromJson(value: unknown): AttendancePeriodSummaryDTO {
  const record = asRecord(value);
  if (!record) throw new Error("attendance port returned a summary that is not an object");
  return {
    tenantId: requiredText(record.tenantId, "tenantId"),
    employeeId: requiredText(record.employeeId, "employeeId"),
    legalEntityId: requiredText(record.legalEntityId, "legalEntityId"),
    periodYear: whole(record.periodYear, "periodYear"),
    periodMonth: whole(record.periodMonth, "periodMonth"),
    approvedOvertimeMinutes: whole(record.approvedOvertimeMinutes, "approvedOvertimeMinutes"),
    locked: record.locked === true,
  };
}

async function postPort(
  fetchImpl: typeof fetch,
  origin: string,
  path: string,
  secret: string,
  tenantId: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetchImpl(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INTERNAL_SECRET_HEADER]: secret,
      [TENANT_HEADER]: tenantId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`port ${path} returned ${response.status}`);
  const payload = (await response.json()) as { data?: unknown };
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new Error(`port ${path} returned no data`);
  }
  return payload.data;
}

async function authorize(secret: string, request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const header = request.headers[INTERNAL_SECRET_HEADER];
  const provided = typeof header === "string" ? header : "";
  if (!secretMatches(provided, secret)) {
    await reply.code(401).send(fail("unauthenticated", "Internal secret is required."));
    return null;
  }
  const tenant = request.headers[TENANT_HEADER];
  if (typeof tenant !== "string" || !UUID.test(tenant)) {
    await reply.code(400).send(fail("invalid_field", "Tenant header must be a uuid."));
    return null;
  }
  return tenant;
}

function secretMatches(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function note(port: string, method: string): void {
  process.stdout.write(`${JSON.stringify({ msg: "internal port", port, method })}\n`);
}

async function readPeriodBody(
  body: unknown,
  reply: FastifyReply,
): Promise<{ legalEntityId: string; periodYear: number; periodMonth: number } | null> {
  const record = asRecord(body);
  const legalEntityId = record?.legalEntityId;
  const periodYear = record?.periodYear;
  const periodMonth = record?.periodMonth;
  if (typeof legalEntityId !== "string" || !UUID.test(legalEntityId)) {
    await reply.code(400).send(fail("invalid_field", "legalEntityId must be a uuid."));
    return null;
  }
  if (typeof periodYear !== "number" || !Number.isInteger(periodYear) || periodYear < 1900 || periodYear > 2199) {
    await reply.code(400).send(fail("invalid_field", "periodYear is invalid."));
    return null;
  }
  if (typeof periodMonth !== "number" || !Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
    await reply.code(400).send(fail("invalid_field", "periodMonth is invalid."));
    return null;
  }
  return { legalEntityId, periodYear, periodMonth };
}

async function readUuidField(body: unknown, field: string, reply: FastifyReply): Promise<string | null> {
  const record = asRecord(body);
  const value = record?.[field];
  if (typeof value !== "string" || !UUID.test(value)) {
    await reply.code(400).send(fail("invalid_field", `${field} must be a uuid.`));
    return null;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`port field ${label} is missing`);
  }
  return value;
}

function money(value: unknown, label: string): EmployeePayrollProfileDTO["baseSalaryIdr"] {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`port field ${label} is not integer rupiah`);
  }
  return idr(BigInt(value));
}

function whole(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`port field ${label} is not a whole number`);
  }
  return value;
}

function risk(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("port field jkkRiskClass is not 1 to 5");
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`port field ${label} is invalid`);
  }
  return value as T;
}

function flags(value: unknown): EmployeePayrollProfileDTO["bpjsFlags"] {
  const record = asRecord(value);
  if (!record) throw new Error("port field bpjsFlags is missing");
  return {
    kesehatan: record.kesehatan === true,
    jht: record.jht === true,
    jkk: record.jkk === true,
    jkm: record.jkm === true,
    jp: record.jp === true,
    jkp: record.jkp === true,
  };
}
