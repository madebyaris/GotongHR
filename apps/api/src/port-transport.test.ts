import assert from "node:assert/strict";
import test from "node:test";
import { idr, type EmployeePayrollProfileDTO } from "@gotonghr/contracts";
import { TENANT_HEADER } from "@gotonghr/identity";
import Fastify from "fastify";
import {
  INTERNAL_SECRET_HEADER,
  STATUTORY_PORT_TENANT,
  createHttpPayrollPorts,
  portPaths,
  profileToJson,
  registerInternalPortRoutes,
} from "./ports/http.ts";

const secret = "internal-secret-0123456789";
const tenantId = "11111111-1111-4111-8111-111111111111";

test("internal port routes require the secret and ignore ports the process does not own", async () => {
  const app = Fastify({ logger: false });
  let profiles = 0;
  await registerInternalPortRoutes(app, {
    secret,
    ports: ["attendance"],
    adapters: {
      coreHr: {
        getActivePayrollProfiles() {
          profiles += 1;
          return Promise.resolve([]);
        },
        employeeIdForUser() {
          return Promise.resolve(null);
        },
      },
      attendance: {
        getLockedPeriodSummaries() {
          return Promise.resolve([]);
        },
        attachPayrollRun() {
          return Promise.resolve({ attached: 0 });
        },
      },
      statutory: {
        getEffectiveTable() {
          return Promise.resolve(null);
        },
      },
    },
  });
  const missing = await app.inject({
    method: "POST",
    url: portPaths.periodSummaries,
    payload: { legalEntityId: tenantId, periodYear: 2099, periodMonth: 1 },
  });
  assert.equal(missing.statusCode, 401);
  const foreign = await app.inject({ method: "POST", url: portPaths.effectiveTable, payload: {} });
  assert.equal(foreign.statusCode, 404);
  const deniedCore = await app.inject({
    method: "POST",
    url: portPaths.payrollProfiles,
    headers: { [INTERNAL_SECRET_HEADER]: secret, [TENANT_HEADER]: tenantId },
    payload: {},
  });
  assert.equal(deniedCore.statusCode, 404);
  assert.equal(profiles, 0);
  const summaries = await app.inject({
    method: "POST",
    url: portPaths.periodSummaries,
    headers: { [INTERNAL_SECRET_HEADER]: secret, [TENANT_HEADER]: tenantId },
    payload: { legalEntityId: tenantId, periodYear: 2099, periodMonth: 1 },
  });
  assert.equal(summaries.statusCode, 200);
  assert.deepEqual(summaries.json().data, []);
  await app.close();
});

test("the http client calls the owning origin and restores integer rupiah", async () => {
  const profile = sampleProfile();
  const seen: { url?: string; secret?: string; tenant?: string } = {};
  const ports = createHttpPayrollPorts({
    secret,
    urls: {
      coreHr: "http://attendance.internal",
      attendance: "http://attendance.internal",
      statutory: "http://ai.internal",
    },
    fetchImpl: (async (url, init) => {
      seen.url = String(url);
      const headers = new Headers(init?.headers);
      seen.secret = headers.get(INTERNAL_SECRET_HEADER) ?? "";
      seen.tenant = headers.get(TENANT_HEADER) ?? "";
      if (String(url).endsWith(portPaths.payrollProfiles)) {
        return jsonResponse({ data: [profileToJson(profile)] });
      }
      return jsonResponse({ data: null });
    }) as typeof fetch,
  });
  const rows = await ports.coreHr.getActivePayrollProfiles({
    tenantId,
    legalEntityId: profile.legalEntityId,
    periodYear: 2099,
    periodMonth: 1,
  });
  assert.equal(seen.url, `http://attendance.internal${portPaths.payrollProfiles}`);
  assert.equal(seen.secret, secret);
  assert.equal(seen.tenant, tenantId);
  assert.equal(rows[0]?.baseSalaryIdr, idr(5_000_000n));
  assert.equal(rows[0]?.userId, null);
  const table = await ports.statutory.getEffectiveTable({ payrollDate: "2099-01-31" });
  assert.equal(table, null);
  assert.equal(seen.url, `http://ai.internal${portPaths.effectiveTable}`);
  assert.equal(seen.tenant, STATUTORY_PORT_TENANT);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sampleProfile(): EmployeePayrollProfileDTO {
  return {
    tenantId,
    employeeId: "22222222-2222-4222-8222-222222222222",
    legalEntityId: "33333333-3333-4333-8333-333333333333",
    branchId: "44444444-4444-4444-8444-444444444444",
    userId: null,
    employeeCode: "E1",
    fullName: "Sari Wulandari",
    jobTitle: "Staff",
    dateOfBirth: "1990-01-15",
    ptkpStatus: "TK/0",
    taxMethod: "gross",
    pph21SubjectType: "permanent",
    baseSalaryIdr: idr(5_000_000n),
    fixedAllowancesIdr: idr(500_000n),
    bpjsFlags: { kesehatan: true, jht: true, jkk: true, jkm: true, jp: true, jkp: true },
    nik: "3174011501900001",
    bankAccountNumber: "1111111111",
    nitku: "0102030405060708000001",
    companyName: "PT Contoh",
    companyNpwp: "0102030405060708",
    umpUmkIdr: idr(1_000_000n),
    jkkRiskClass: 1,
  };
}
