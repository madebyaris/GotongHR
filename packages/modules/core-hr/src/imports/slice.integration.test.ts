import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fail, type PermissionAtom } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { createLocalStorage, type LocalObjectStorage } from "@gotonghr/storage";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type LightMyRequestResponse,
} from "fastify";
import pg from "pg";
import type { CoreHrAuth } from "../auth.ts";
import { registerEmployeeDocuments } from "../documents/routes.ts";
import { registerCoreHr } from "../routes.ts";
import { ALL_OR_NOTHING_ROLLBACK, DRY_RUN_WRITES_NOTHING } from "./queue.ts";
import { BAD_NIK_LINES, badNikCsv, validEmployeeCsv } from "./fixtures.ts";
import { processEmployeeImport } from "./process.ts";
import { registerEmployeeImports } from "./routes.ts";

const execFileAsync = promisify(execFile);
const { Client } = pg;
const RSS_LIMIT = 512 * 1024 * 1024;

loadRepoEnv();
applyDatabaseUrls(process.env);
process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";

interface Company {
  tenantId: string;
  userId: string;
  orgId: string;
  legalEntityId: string;
  branchId: string;
}

interface UploadBody {
  documentId?: string;
  storageKey: string;
  upload: { url: string; method: string; headers: Record<string, string> };
}

interface ImportJobJson {
  id: string;
  status: string;
  mode: string;
  allOrNothing: boolean;
  writtenRows: number;
  totalRows: number;
  lineErrors: { line: number; field: string; message: string }[];
  error: { code: string; message: string; allOrNothing: boolean; written: number } | null;
}

describe("documents and csv import", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let appDb: TenantDatabase;
  let platform: pg.Client;
  let superuser: pg.Client;
  let storage: LocalObjectStorage;
  let storageRoot: string;
  let companyA: Company;
  let companyB: Company;
  const queued: { tenantId: string; importJobId: string }[] = [];

  before(async () => {
    await applySchemas();
    storageRoot = await mkdtemp(`${tmpdir()}/gotong-import-`);
    storage = createLocalStorage({
      rootDir: storageRoot,
      secret: "core-hr-import-test-secret-32",
      urlPrefix: "",
    });
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
    companyA = await seedCompany(superuser, "A");
    companyB = await seedCompany(superuser, "B");
    app = Fastify({ logger: false });
    await storage.registerRoutes(app);
    const guard = (permission: PermissionAtom) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const permissions = headerList(request.headers["x-test-permissions"]);
        if (!permissions.includes(permission)) {
          await reply.code(403).send(fail("forbidden", "Missing permission."));
        }
      };
    };
    const readAuth = (request: FastifyRequest): CoreHrAuth | null => {
      const tenantId = headerOne(request.headers["x-test-tenant"]);
      const userId = headerOne(request.headers["x-test-user"]);
      if (!tenantId || !userId) return null;
      return {
        tenantId,
        userId,
        role: "hr_admin",
        permissions: headerList(request.headers["x-test-permissions"]),
        scopeEntityIds: [],
        scopeBranchIds: [],
        directReportsOnly: false,
        selfOnly: false,
        ipAddress: "127.0.0.1",
        userAgent: "core-hr-import-test",
      };
    };
    const enqueueEmployeeImport = async (message: { tenantId: string; importJobId: string }) => {
      queued.push(message);
    };
    await registerCoreHr(app, { appDb, guard, readAuth });
    await registerEmployeeDocuments(app, { appDb, storage, guard, readAuth });
    await registerEmployeeImports(app, { appDb, storage, guard, readAuth, enqueueEmployeeImport });
  });

  after(async () => {
    await app.close();
    await cleanup(superuser, [companyA, companyB]);
    await appDb.end();
    await platform.end();
    await superuser.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("stores document metadata and a presigned download, not the file bytes", async () => {
    const employee = await createEmployee(app, companyA, "DOC1", "3273011508950101");
    const marker = "DOCBYTES-MARKER-NOT-IN-DB";
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/documents/upload-url`,
      headers: authHeaders(companyA, ["employee.read"]),
      payload: { fileName: "ktp.pdf", contentType: "application/pdf", byteSize: marker.length, docType: "ktp" },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const wrongType = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/documents/upload-url`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { fileName: "ktp.pdf", contentType: "text/plain", byteSize: marker.length, docType: "ktp" },
    });
    assert.equal(wrongType.statusCode, 400, wrongType.body);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/documents/upload-url`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { fileName: "ktp.pdf", contentType: "application/pdf", byteSize: marker.length, docType: "ktp" },
    });
    assert.equal(upload.statusCode, 200, upload.body);
    const signed = dataOf<UploadBody>(upload);
    assert.ok(signed.documentId);
    assert.equal(signed.storageKey.startsWith(`t/${companyA.tenantId}/emp/${employee.id}/doc/`), true);
    const put = await app.inject({
      method: "PUT",
      url: signed.upload.url,
      headers: signed.upload.headers,
      payload: marker,
    });
    assert.equal(put.statusCode, 200, put.body);
    const saved = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/documents`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: {
        documentId: signed.documentId,
        storageKey: signed.storageKey,
        fileName: "ktp.pdf",
        contentType: "application/pdf",
        byteSize: marker.length,
        docType: "ktp",
      },
    });
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(saved.body.includes(marker), false);
    const documentId = dataOf<{ id: string }>(saved).id;
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${employee.id}/documents`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.body.includes(marker), false);
    assert.equal(listed.body.includes(documentId), true);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${employee.id}/documents`,
      headers: authHeaders(companyB, ["employee.read"]),
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
    const download = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${employee.id}/documents/${documentId}/download-url`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(download.statusCode, 200, download.body);
    const fetched = await app.inject({ method: "GET", url: dataOf<{ url: string }>(download).url });
    assert.equal(fetched.body, marker);
    const row = await superuser.query<{ payload: string }>(
      `SELECT row_to_json(hr_documents)::text AS payload FROM hr_documents WHERE id = $1::uuid`,
      [documentId],
    );
    assert.equal(row.rows[0]?.payload.includes(marker), false);
    const columns = await superuser.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'hr_documents'`,
    );
    assert.equal(columns.rows.some((column) => column.data_type === "bytea"), false);
    const audit = await superuser.query(
      `SELECT id FROM aud_events WHERE action = 'employee.document.create' AND resource_id = $1::uuid`,
      [documentId],
    );
    assert.equal(audit.rowCount, 1);
    await assert.rejects(platform.query("SELECT id FROM hr_documents"), (error: unknown) => codeOf(error) === "42501");
  });

  it("returns the three bad NIK lines and writes no employees", async () => {
    const before = await employeeCount(superuser, companyA.tenantId);
    const job = await importCsv(app, appDb, storage, companyA, badNikCsv(), "commit", queued);
    assert.equal(job.status, "failed");
    assert.equal(job.allOrNothing, true);
    assert.equal(job.writtenRows, 0);
    assert.equal(job.error?.code, "import_rolled_back");
    assert.equal(job.error?.message, ALL_OR_NOTHING_ROLLBACK);
    assert.equal(job.error?.written, 0);
    assert.deepEqual(
      job.lineErrors.filter((error) => error.field === "nik").map((error) => error.line).sort((left, right) => left - right),
      [...BAD_NIK_LINES],
    );
    assert.equal(job.lineErrors.some((error) => error.message.includes("3273013208950001")), false);
    assert.equal(await employeeCount(superuser, companyA.tenantId), before);
  });

  it("dry-run returns the row errors and writes no employees", async () => {
    const before = await employeeCount(superuser, companyA.tenantId);
    const job = await importCsv(app, appDb, storage, companyA, badNikCsv(), "dry_run", queued);
    assert.equal(job.status, "completed");
    assert.equal(job.writtenRows, 0);
    assert.equal(job.error?.code, "dry_run");
    assert.equal(job.error?.message, DRY_RUN_WRITES_NOTHING);
    assert.deepEqual(
      job.lineErrors.filter((error) => error.field === "nik").map((error) => error.line).sort((left, right) => left - right),
      [...BAD_NIK_LINES],
    );
    assert.equal(await employeeCount(superuser, companyA.tenantId), before);
  });

  it("commits 500 streamed rows under the 512 MB RSS cap", { timeout: 180_000 }, async () => {
    const csv = validEmployeeCsv(500);
    const before = await employeeCount(superuser, companyB.tenantId);
    let peak = process.memoryUsage().rss;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    let job: ImportJobJson;
    try {
      job = await importCsv(app, appDb, storage, companyB, csv, "commit", queued, (current) => {
        peak = Math.max(peak, current);
      });
    } finally {
      clearInterval(timer);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    console.log(`csv import peak rss bytes ${peak}`);
    assert.equal(peak > RSS_LIMIT, false, `peak rss ${peak}`);
    assert.equal(job.status, "completed");
    assert.equal(job.writtenRows, 500);
    assert.equal(job.totalRows, 500);
    assert.equal(job.allOrNothing, true);
    assert.equal(await employeeCount(superuser, companyB.tenantId), before + 500);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers: authHeaders(companyB, ["employee.read"]),
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.body.includes("3273011508950001"), false);
    assert.equal(listed.body.includes("3273********0001"), true);
    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/employees/import/${job.id}`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
    await assert.rejects(platform.query("SELECT id FROM hr_import_jobs"), (error: unknown) => codeOf(error) === "42501");
  });
});

async function importCsv(
  app: FastifyInstance,
  appDb: TenantDatabase,
  storage: LocalObjectStorage,
  company: Company,
  csv: string,
  mode: "dry_run" | "commit",
  queued: { tenantId: string; importJobId: string }[],
  onRss?: (rss: number) => void,
): Promise<ImportJobJson> {
  const upload = await app.inject({
    method: "POST",
    url: "/api/v1/employees/import/upload-url",
    headers: authHeaders(company, ["employee.write"]),
    payload: { byteSize: Buffer.byteLength(csv) },
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const signed = dataOf<UploadBody>(upload);
  const put = await app.inject({
    method: "PUT",
    url: signed.upload.url,
    headers: signed.upload.headers,
    payload: csv,
  });
  assert.equal(put.statusCode, 200, put.body);
  const started = queued.length;
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/employees/import",
    headers: authHeaders(company, ["employee.write"]),
    payload: {
      storageKey: signed.storageKey,
      mode,
      legalEntityId: company.legalEntityId,
      branchId: company.branchId,
    },
  });
  assert.equal(created.statusCode, 202, created.body);
  assert.equal(queued.length, started + 1);
  const message = queued[queued.length - 1];
  assert.ok(message);
  assert.equal(dataOf<ImportJobJson>(created).id, message.importJobId);
  const processed = await processEmployeeImport({ appDb, storage }, message);
  onRss?.(processed.peakRssBytes);
  const status = await app.inject({
    method: "GET",
    url: `/api/v1/employees/import/${message.importJobId}`,
    headers: authHeaders(company, ["employee.read"]),
  });
  assert.equal(status.statusCode, 200, status.body);
  return dataOf<ImportJobJson>(status);
}

async function createEmployee(
  app: FastifyInstance,
  company: Company,
  code: string,
  nik: string,
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers: authHeaders(company, ["employee.write"]),
    payload: {
      employeeCode: code,
      fullName: "Sari Wulandari",
      legalEntityId: company.legalEntityId,
      branchId: company.branchId,
      employmentStatus: "active",
      joinDate: "2024-03-01",
      ptkpStatus: "TK/0",
      taxMethod: "gross",
      pph21SubjectType: "permanent",
      nik,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return dataOf(response);
}

async function applySchemas(): Promise<void> {
  const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
  const source = `
    import { migrate, migrateEnvFrom, loadRepoEnv, applyDatabaseUrls } from ${JSON.stringify(`${repo}/packages/db/dist/index.js`)};
    import { migrateIdentity } from ${JSON.stringify(`${repo}/packages/modules/identity/dist/migrate.js`)};
    import { migrateAudit } from ${JSON.stringify(`${repo}/packages/modules/audit/dist/migrate.js`)};
    import { migrateCoreHr } from ${JSON.stringify(`${repo}/packages/modules/core-hr/dist/migrate.js`)};
    loadRepoEnv();
    applyDatabaseUrls(process.env);
    const env = migrateEnvFrom(process.env);
    await migrate(env);
    await migrateIdentity({ superuserUrl: env.superuserUrl, migratorUrl: env.migratorUrl });
    await migrateAudit({ migratorUrl: env.migratorUrl });
    await migrateCoreHr({ migratorUrl: env.migratorUrl });
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repo,
    env: process.env,
  });
}

async function seedCompany(superuser: pg.Client, label: string): Promise<Company> {
  const tenantId = randomUUID();
  const orgId = `import-${label}-${tenantId}`;
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const userId = randomUUID();
  const npwp = label === "A" ? "1000000000000201" : "1000000000000202";
  const nitku = label === "A" ? "1000000000000000000201" : "1000000000000000000202";
  await superuser.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, $2, $1)`, [orgId, `Import ${label}`]);
  await superuser.query(
    `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, $3, $2)`,
    [tenantId, orgId, `Import ${label}`],
  );
  await superuser.query(
    `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16) VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [legalEntityId, tenantId, `PT Import ${label}`, npwp],
  );
  await superuser.query(
    `INSERT INTO id_branches (id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'Asia/Jakarta', 5000000)`,
    [branchId, tenantId, legalEntityId, `HQ ${label}`, nitku],
  );
  return { tenantId, userId, orgId, legalEntityId, branchId };
}

async function cleanup(superuser: pg.Client, companies: Company[]): Promise<void> {
  const tenants = companies.map((company) => company.tenantId);
  const orgs = companies.map((company) => company.orgId);
  await superuser.query("DELETE FROM aud_pii_access_logs WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_outbox_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_tenant_keys WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_documents WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employee_pii WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employees WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_import_jobs WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_branches WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_legal_entities WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [orgs]);
}

function authHeaders(company: Company, permissions: string[]): Record<string, string> {
  return {
    "x-test-tenant": company.tenantId,
    "x-test-user": company.userId,
    "x-test-permissions": permissions.join(","),
  };
}

async function employeeCount(superuser: pg.Client, tenantId: string): Promise<number> {
  const result = await superuser.query("SELECT id FROM hr_employees WHERE tenant_id = $1::uuid", [tenantId]);
  return result.rowCount ?? 0;
}

function dataOf<T>(response: LightMyRequestResponse): T {
  return (JSON.parse(response.body) as { data: T }).data;
}

function headerOne(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

function headerList(value: string | string[] | undefined): string[] {
  const first = headerOne(value);
  return first ? first.split(",").filter((item) => item.length > 0) : [];
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
