import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@gotonghr/audit";
import {
  idr,
  type AttendancePayrollPort,
  type AttendancePeriodSummaryDTO,
  type CoreHrPayrollPort,
  type EmployeePayrollProfileDTO,
  type StatutoryPayrollPort,
} from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import {
  BankBatchInputError,
  bankBatchIds,
  buildCoretaxBatch,
  CoretaxWithholderError,
  formatBankBatch,
  preflightCoretaxRecords,
  rupiah,
  terCategoryForPtkp,
  terRate,
  type BankBatchId,
  type BpmpRecord,
} from "@gotonghr/payroll-engine";
import { sql } from "drizzle-orm";
import type { PayrollCaller } from "./caller.ts";
import { hasPermission } from "./caller.ts";
import { readStatutoryTable, toJsonRecord, type StoredBpjs, type StoredDeductions, type StoredEarnings, type StoredPph21 } from "./calculate.ts";
import { PayrollError } from "./errors.ts";
import { sha256 } from "./jobs.ts";
import { chunk, parsePeriod, type PayrollPeriod } from "./period.ts";
import { PAYROLL_BATCH_SIZE, PAYSLIP_URL_TTL_SECONDS, type PayrollCalcMessage, type PayrollPdfMessage, type PayrollQueuePort, type PayrollStoragePort } from "./ports.ts";
import { asJson, errorCode, jsonText, queryRows } from "./sql.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ACCOUNT = /^[0-9]{8,18}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export interface PayrollDeps {
  appDb: TenantDatabase;
  coreHr: CoreHrPayrollPort;
  attendance: AttendancePayrollPort;
  statutory: StatutoryPayrollPort;
  queue: PayrollQueuePort;
  storage: PayrollStoragePort;
}

export interface PayRunView {
  id: string;
  legalEntityId: string;
  periodYearMonth: string;
  status: string;
  statutoryTableVersionId: string | null;
  totalGrossIdr: string;
  totalTaxIdr: string;
  totalNetIdr: string;
  pdfBatchEnqueuedCount: number;
  approvedBy: string | null;
  approvedAt: string | null;
  finalizedBy: string | null;
  finalizedAt: string | null;
}

export interface PayRunItemView {
  id: string;
  employeeId: string;
  earnings: StoredEarnings;
  deductions: StoredDeductions;
  bpjs: StoredBpjs;
  pph21: StoredPph21;
  grossIdr: string;
  taxIdr: string;
  netIdr: string;
  payslipStorageKey: string | null;
  payslipGeneratedAt: string | null;
}

export interface PayRunDetail {
  run: PayRunView;
  items: PayRunItemView[];
}

export interface ExportView {
  id: string;
  kind: "coretax" | "bank_batch";
  storageKey: string;
  checksumSha256: string;
  byteSize: string;
  downloadUrl: string;
}

const runColumns = sql`
  id::text AS id,
  legal_entity_id::text AS legal_entity_id,
  period_year_month,
  status,
  statutory_table_version_id::text AS statutory_table_version_id,
  total_gross_idr::text AS total_gross_idr,
  total_tax_idr::text AS total_tax_idr,
  total_net_idr::text AS total_net_idr,
  pdf_batch_enqueued_count,
  approved_by::text AS approved_by,
  approved_at,
  finalized_by::text AS finalized_by,
  finalized_at
`;

interface RunRow {
  id: string;
  legal_entity_id: string;
  period_year_month: string;
  status: string;
  statutory_table_version_id: string | null;
  total_gross_idr: string;
  total_tax_idr: string;
  total_net_idr: string;
  pdf_batch_enqueued_count: number | string;
  approved_by: string | null;
  approved_at: Date | string | null;
  finalized_by: string | null;
  finalized_at: Date | string | null;
}

export async function createRun(deps: PayrollDeps, caller: PayrollCaller, body: unknown): Promise<PayRunView> {
  requireAny(caller, ["payroll.run.create"], "payroll.run.create is required.");
  const input = readCreate(body);
  try {
    return await deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
      const rows = queryRows<RunRow>(
        await tx.execute(sql`
          INSERT INTO pay_runs (tenant_id, legal_entity_id, period_year_month)
          VALUES (${caller.tenantId}::uuid, ${input.legalEntityId}::uuid, ${input.periodYearMonth})
          RETURNING ${runColumns}
        `),
      );
      const row = rows[0];
      if (!row) throw new PayrollError(500, "internal_error", "Payroll run was not created.");
      await audit(tx, caller, "payroll.run.create", row.id, {
        status: "draft",
        periodYearMonth: input.periodYearMonth,
        legalEntityId: input.legalEntityId,
      });
      return toRun(row);
    });
  } catch (error) {
    if (errorCode(error) === "23505") {
      throw new PayrollError(409, "conflict", "A payroll run already exists for this company and month.");
    }
    throw error;
  }
}

export async function getRun(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<PayRunDetail> {
  requireAny(
    caller,
    ["payroll.run.prepare", "payroll.run.create", "payroll.run.finalize", "payroll.coretax.export"],
    "A payroll permission is required.",
  );
  assertUuid(runId, "run id");
  return deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    const run = await findRun(tx, runId);
    const items = await listItems(tx, runId);
    return { run: toRun(run), items };
  });
}

export async function preflightRun(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<{ employeeCount: number }> {
  requireAny(caller, ["payroll.run.prepare"], "payroll.run.prepare is required.");
  const run = await requireRun(deps, caller, runId);
  const inputs = await loadInputs(deps, caller, run);
  assertLocked(inputs);
  const tableVersion = await deps.statutory.getEffectiveTable({ payrollDate: inputs.period.end });
  if (!tableVersion) {
    throw new PayrollError(422, "no_statutory_table", "No published statutory table covers this payroll date.");
  }
  const table = readStatutoryTable(tableVersion.payload);
  const records = inputs.profiles.map((profile) =>
    bpmpFromProfile(profile, inputs.period, profile.baseSalaryIdr + profile.fixedAllowancesIdr, table),
  );
  const report = preflightCoretaxRecords(records, withholderOf(inputs.profiles), "BPMP");
  const fields = [
    ...report.withholderIssues.map((issue) => ({ field: issue.field, message: issue.reason })),
    ...report.issues.map((issue) => ({ field: issue.field, message: issue.reason })),
  ];
  if (fields.length > 0) {
    throw new PayrollError(422, "coretax_preflight", "Coretax preflight failed.", fields);
  }
  await deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    await audit(tx, caller, "payroll.run.preflight", run.id, {
      periodYearMonth: run.period_year_month,
      employeeCount: inputs.profiles.length,
    });
  });
  return { employeeCount: inputs.profiles.length };
}

export async function calculateRun(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<PayRunView> {
  requireAny(caller, ["payroll.run.prepare"], "payroll.run.prepare is required.");
  const run = await requireRun(deps, caller, runId);
  const inputs = await loadInputs(deps, caller, run);
  assertLocked(inputs);
  const tableVersion = await deps.statutory.getEffectiveTable({ payrollDate: inputs.period.end });
  if (!tableVersion) {
    throw new PayrollError(422, "no_statutory_table", "No published statutory table covers this payroll date.");
  }
  const batches = chunk(inputs.profiles, PAYROLL_BATCH_SIZE);
  const messages: PayrollCalcMessage[] = batches.map((employees, batchIndex) => ({
    tenantId: caller.tenantId,
    runId: run.id,
    batchIndex,
    batchCount: batches.length,
    statutoryTableVersionId: tableVersion.id,
    tablePayload: tableVersion.payload,
    employees: employees.map((profile) => ({
      profile: toJsonRecord(profile),
      attendance: toJsonRecord(requiredSummary(inputs.summaries, profile.employeeId)),
    })),
  }));
  await deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    await deps.attendance.attachPayrollRun({
      tenantId: caller.tenantId,
      legalEntityId: run.legal_entity_id,
      periodYear: inputs.period.year,
      periodMonth: inputs.period.month,
      runId: run.id,
    });
    const claimed = queryRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE pay_runs
        SET statutory_table_version_id = ${tableVersion.id}::uuid,
            calc_batch_total = ${batches.length},
            updated_at = now()
        WHERE id = ${run.id}::uuid
          AND status = 'draft'
          AND calc_batch_total = 0
        RETURNING id::text AS id
      `),
    );
    if (!claimed[0]) {
      throw new PayrollError(409, "conflict", "This payroll run is not a draft waiting to be calculated.");
    }
    await audit(tx, caller, "payroll.run.calculate", run.id, {
      periodYearMonth: run.period_year_month,
      employeeCount: inputs.profiles.length,
      batchCount: batches.length,
      statutoryTableVersionId: tableVersion.id,
    });
  });
  await deps.queue.enqueueCalculation(messages);
  return (await getRun(deps, caller, run.id)).run;
}

export async function approveRun(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<PayRunView> {
  requireAny(caller, ["payroll.run.prepare"], "payroll.run.prepare is required.");
  assertUuid(runId, "run id");
  return deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    const rows = queryRows<RunRow>(
      await tx.execute(sql`
        UPDATE pay_runs
        SET status = 'approved',
            approved_by = ${caller.userId}::uuid,
            approved_at = now(),
            updated_at = now()
        WHERE id = ${runId}::uuid
          AND status = 'calculated'
        RETURNING ${runColumns}
      `),
    );
    const row = rows[0];
    if (!row) throw new PayrollError(409, "conflict", "Only a calculated payroll run can be approved.");
    await audit(tx, caller, "payroll.run.approve", row.id, { status: "approved" });
    return toRun(row);
  });
}

export async function finalizeRun(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<PayRunView> {
  if (!hasPermission(caller, "payroll.run.finalize")) {
    throw new PayrollError(403, "forbidden", "payroll.run.finalize is required.");
  }
  if (!caller.sessionTotpVerified) {
    throw new PayrollError(403, "totp_verification_required", "Verify the authenticator code for this session.");
  }
  assertUuid(runId, "run id");
  const messages = await deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    const locked = queryRows<RunRow>(
      await tx.execute(sql`
        SELECT ${runColumns}
        FROM pay_runs
        WHERE id = ${runId}::uuid
        FOR UPDATE
      `),
    )[0];
    if (!locked) throw new PayrollError(404, "not_found", "Payroll run was not found.");
    if (locked.status !== "approved") {
      throw new PayrollError(409, "conflict", "Only an approved payroll run can be finalized.");
    }
    const itemIds = queryRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id::text AS id
        FROM pay_run_items
        WHERE run_id = ${runId}::uuid
        ORDER BY employee_id
      `),
    ).map((row) => row.id);
    const batches = chunk(itemIds, PAYROLL_BATCH_SIZE);
    if (batches.length === 0) {
      throw new PayrollError(422, "no_employees", "This payroll run has no lines to print.");
    }
    const updated = queryRows<RunRow>(
      await tx.execute(sql`
        UPDATE pay_runs
        SET status = 'finalized',
            finalized_by = ${caller.userId}::uuid,
            finalized_at = now(),
            pdf_batch_enqueued_count = ${batches.length},
            updated_at = now()
        WHERE id = ${runId}::uuid
          AND status = 'approved'
        RETURNING ${runColumns}
      `),
    );
    if (!updated[0]) throw new PayrollError(409, "conflict", "Only an approved payroll run can be finalized.");
    await audit(tx, caller, "payroll.run.finalize", runId, {
      status: "finalized",
      pdfBatchCount: batches.length,
    });
    return batches.map(
      (ids, batchIndex): PayrollPdfMessage => ({
        tenantId: caller.tenantId,
        runId,
        batchIndex,
        itemIds: ids,
      }),
    );
  });
  await deps.queue.enqueuePayslips(messages);
  return (await getRun(deps, caller, runId)).run;
}

export async function exportCoretax(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<ExportView> {
  requireAny(caller, ["payroll.run.prepare", "payroll.coretax.export"], "payroll.coretax.export is required.");
  const detail = await calculatedDetail(deps, caller, runId);
  const first = detail.items[0];
  if (!first) throw new PayrollError(422, "no_employees", "This payroll run has no lines to export.");
  const snapshot = await employeeSnapshot(deps, caller, first.id);
  const records: BpmpRecord[] = [];
  for (const item of detail.items) {
    const employee = await employeeSnapshot(deps, caller, item.id);
    if (employee.pph21SubjectType !== "permanent") continue;
    records.push(
      bpmpRecord({
        employeeId: item.employeeId,
        nik: textOf(employee, "nik"),
        name: textOf(employee, "fullName"),
        ptkpStatus: textOf(employee, "ptkpStatus"),
        nitku: textOf(employee, "nitku"),
        year: yearOf(detail.run.periodYearMonth),
        month: monthOf(detail.run.periodYearMonth),
        withholdingDate: periodEnd(detail.run.periodYearMonth),
        position: textOf(employee, "jobTitle"),
        grossIdr: BigInt(item.grossIdr),
        ratePerScale: BigInt(item.pph21.ratePerScale),
        rateScale: BigInt(item.pph21.rateScale),
      }),
    );
  }
  let built;
  try {
    built = buildCoretaxBatch({
      slipType: "BPMP",
      withholder: { npwp: textOf(snapshot, "companyNpwp"), nitku: textOf(snapshot, "nitku") },
      records,
    });
  } catch (error) {
    if (error instanceof CoretaxWithholderError) {
      throw new PayrollError(
        422,
        "coretax_preflight",
        "Coretax withholder NPWP or NITKU cannot head a file.",
        error.issues.map((issue) => ({ field: issue.field, message: issue.reason })),
      );
    }
    throw error;
  }
  if (built.preflight.issues.length > 0 || records.length === 0) {
    throw new PayrollError(422, "coretax_preflight", "Coretax export has records that cannot be filed.", 
      built.preflight.issues.map((issue) => ({ field: issue.field, message: issue.reason })),
    );
  }
  const body = new TextEncoder().encode(built.xml);
  return storeExport(deps, caller, detail.run.id, {
    kind: "coretax",
    slipType: "BPMP",
    bankId: null,
    extension: "xml",
    contentType: "application/xml",
    body,
    metadata: { slipType: "BPMP", recordCount: records.length },
  });
}

export async function exportBank(deps: PayrollDeps, caller: PayrollCaller, runId: string, body: unknown): Promise<ExportView> {
  requireAny(caller, ["payroll.run.prepare", "payroll.coretax.export"], "payroll.run.prepare is required.");
  const request = readBank(body);
  const detail = await calculatedDetail(deps, caller, runId);
  const payments = [];
  for (const item of detail.items) {
    const employee = await employeeSnapshot(deps, caller, item.id);
    payments.push({
      employeeId: item.employeeId,
      accountNumber: textOf(employee, "bankAccountNumber"),
      accountName: textOf(employee, "fullName"),
      amountIdr: rupiah(BigInt(item.netIdr)),
      remark: `Gaji ${detail.run.periodYearMonth}`,
    });
  }
  let file;
  try {
    file = formatBankBatch(request.bank, {
      debitAccountNumber: request.debitAccountNumber,
      effectiveDate: request.effectiveDate ?? periodEnd(detail.run.periodYearMonth),
      payments,
    });
  } catch (error) {
    if (error instanceof BankBatchInputError) {
      throw new PayrollError(422, "bank_batch", error.message);
    }
    throw error;
  }
  if (file.detailCount === 0) {
    throw new PayrollError(422, "bank_batch", "No payment row was accepted.");
  }
  const bytes = new TextEncoder().encode(file.body);
  return storeExport(deps, caller, detail.run.id, {
    kind: "bank_batch",
    slipType: null,
    bankId: request.bank,
    extension: "csv",
    contentType: "text/csv",
    body: bytes,
    metadata: {
      bank: request.bank,
      fileName: file.fileName,
      detailCount: file.detailCount,
      excludedCount: file.excluded.length,
    },
  });
}

export async function payslipDownloadUrl(
  deps: PayrollDeps,
  caller: PayrollCaller,
  itemId: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  assertUuid(itemId, "payslip id");
  const owned = await deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    const rows = queryRows<{ employee_id: string; owner_user_id: string | null; payslip_storage_key: string | null }>(
      await tx.execute(sql`
        SELECT employee_id::text AS employee_id,
               owner_user_id::text AS owner_user_id,
               payslip_storage_key
        FROM pay_run_items
        WHERE id = ${itemId}::uuid
      `),
    );
    return rows[0] ?? null;
  });
  if (!owned) throw new PayrollError(404, "not_found", "Payslip was not found.");
  const employeeId = caller.employeeId ?? (await deps.coreHr.employeeIdForUser({ tenantId: caller.tenantId, userId: caller.userId }));
  const owns = (employeeId !== null && employeeId === owned.employee_id) || owned.owner_user_id === caller.userId;
  if (!owns) throw new PayrollError(403, "forbidden", "You cannot download this payslip.");
  if (!owned.payslip_storage_key) {
    throw new PayrollError(409, "not_ready", "The payslip PDF is not ready.");
  }
  const signed = await deps.storage.presignGet({
    key: owned.payslip_storage_key,
    expiresInSeconds: PAYSLIP_URL_TTL_SECONDS,
  });
  return { url: signed.url, expiresInSeconds: PAYSLIP_URL_TTL_SECONDS };
}

async function storeExport(
  deps: PayrollDeps,
  caller: PayrollCaller,
  runId: string,
  file: {
    kind: "coretax" | "bank_batch";
    slipType: string | null;
    bankId: string | null;
    extension: string;
    contentType: string;
    body: Uint8Array;
    metadata: Record<string, unknown>;
  },
): Promise<ExportView> {
  const id = randomUUID();
  const key = `exports/${caller.tenantId}/${runId}/${file.kind}-${id}.${file.extension}`;
  const checksum = sha256(file.body);
  await deps.storage.put({ key, body: file.body, contentType: file.contentType });
  await deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO pay_exports (
        id, tenant_id, run_id, export_kind, slip_type, bank_id,
        storage_key, checksum_sha256, byte_size, metadata_json
      ) VALUES (
        ${id}::uuid,
        ${caller.tenantId}::uuid,
        ${runId}::uuid,
        ${file.kind},
        ${file.slipType},
        ${file.bankId},
        ${key},
        ${checksum},
        ${String(file.body.byteLength)}::bigint,
        ${jsonText(file.metadata)}::jsonb
      )
    `);
    await audit(tx, caller, file.kind === "coretax" ? "payroll.export.coretax" : "payroll.export.bank", runId, {
      exportId: id,
      kind: file.kind,
      byteSize: file.body.byteLength,
    });
  });
  const signed = await deps.storage.presignGet({ key, expiresInSeconds: PAYSLIP_URL_TTL_SECONDS });
  return {
    id,
    kind: file.kind,
    storageKey: key,
    checksumSha256: checksum,
    byteSize: String(file.body.byteLength),
    downloadUrl: signed.url,
  };
}

async function calculatedDetail(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<PayRunDetail> {
  const detail = await getRun(deps, caller, runId);
  if (detail.run.status === "draft") {
    throw new PayrollError(409, "conflict", "Calculate the payroll run before exporting it.");
  }
  return detail;
}

async function employeeSnapshot(
  deps: PayrollDeps,
  caller: PayrollCaller,
  itemId: string,
): Promise<Record<string, unknown>> {
  return deps.appDb.withTenantContext(caller.tenantId, async (tx) => {
    const rows = queryRows<{ employee_snapshot_json: unknown }>(
      await tx.execute(sql`
        SELECT employee_snapshot_json FROM pay_run_items WHERE id = ${itemId}::uuid
      `),
    );
    const value = asJson(rows[0]?.employee_snapshot_json);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PayrollError(500, "internal_error", "Employee snapshot was not stored.");
    }
    return value as Record<string, unknown>;
  });
}

interface Inputs {
  period: PayrollPeriod;
  profiles: EmployeePayrollProfileDTO[];
  summaries: Map<string, AttendancePeriodSummaryDTO>;
}

async function loadInputs(deps: PayrollDeps, caller: PayrollCaller, run: RunRow): Promise<Inputs> {
  const period = parsePeriod(run.period_year_month);
  if (!period) throw new PayrollError(500, "internal_error", "Stored period is not YYYY-MM.");
  const profiles = await deps.coreHr.getActivePayrollProfiles({
    tenantId: caller.tenantId,
    legalEntityId: run.legal_entity_id,
    periodYear: period.year,
    periodMonth: period.month,
  });
  const summaries = await deps.attendance.getLockedPeriodSummaries({
    tenantId: caller.tenantId,
    legalEntityId: run.legal_entity_id,
    periodYear: period.year,
    periodMonth: period.month,
  });
  return {
    period,
    profiles: [...profiles].sort((left, right) => left.employeeId.localeCompare(right.employeeId)),
    summaries: new Map(summaries.map((row) => [row.employeeId, row])),
  };
}

function assertLocked(inputs: Inputs): void {
  if (inputs.profiles.length === 0) {
    throw new PayrollError(422, "no_employees", "This company has no active employees for the month.");
  }
  const open = inputs.profiles.filter((profile) => inputs.summaries.get(profile.employeeId)?.locked !== true);
  if (open.length > 0) {
    throw new PayrollError(422, "attendance_unlocked", "Lock the attendance period before payroll.", [
      { field: "periodYearMonth", message: "Attendance for this month is not locked." },
    ]);
  }
}

function requiredSummary(
  summaries: Map<string, AttendancePeriodSummaryDTO>,
  employeeId: string,
): AttendancePeriodSummaryDTO {
  const summary = summaries.get(employeeId);
  if (!summary) throw new PayrollError(422, "attendance_unlocked", "Lock the attendance period before payroll.");
  return summary;
}

function withholderOf(profiles: readonly EmployeePayrollProfileDTO[]): { npwp: string; nitku: string } {
  const first = profiles[0];
  if (!first) throw new PayrollError(422, "no_employees", "This company has no active employees for the month.");
  return { npwp: first.companyNpwp, nitku: first.nitku };
}

function bpmpFromProfile(
  profile: EmployeePayrollProfileDTO,
  period: PayrollPeriod,
  gross: bigint,
  table: ReturnType<typeof readStatutoryTable>,
): BpmpRecord {
  const rate = terRate(table, terCategoryForPtkp(profile.ptkpStatus), gross);
  return bpmpRecord({
    employeeId: profile.employeeId,
    nik: profile.nik,
    name: profile.fullName,
    ptkpStatus: profile.ptkpStatus,
    nitku: profile.nitku,
    year: period.year,
    month: period.month,
    withholdingDate: period.end,
    position: profile.jobTitle,
    grossIdr: gross,
    ratePerScale: rate.ratePerScale,
    rateScale: rate.rateScale,
  });
}

function bpmpRecord(input: {
  employeeId: string;
  nik: string;
  name: string;
  ptkpStatus: string;
  nitku: string;
  year: number;
  month: number;
  withholdingDate: string;
  position: string;
  grossIdr: bigint;
  ratePerScale: bigint;
  rateScale: bigint;
}): BpmpRecord {
  return {
    slipType: "BPMP",
    employeeId: input.employeeId,
    nik: input.nik,
    name: input.name,
    ptkpStatus: input.ptkpStatus,
    nitku: input.nitku,
    taxPeriodYear: input.year,
    taxPeriodMonth: input.month,
    withholdingDate: input.withholdingDate,
    taxObjectCode: "21-100-01",
    counterpartOpt: "Resident",
    passportNumber: "",
    position: input.position,
    taxCertificate: "N/A",
    grossIdr: idr(input.grossIdr),
    rate: { ratePerScale: input.ratePerScale, rateScale: input.rateScale },
  };
}

async function requireRun(deps: PayrollDeps, caller: PayrollCaller, runId: string): Promise<RunRow> {
  assertUuid(runId, "run id");
  return deps.appDb.withTenantContext(caller.tenantId, (tx) => findRun(tx, runId));
}

async function findRun(tx: TenantTx, runId: string): Promise<RunRow> {
  const rows = queryRows<RunRow>(
    await tx.execute(sql`SELECT ${runColumns} FROM pay_runs WHERE id = ${runId}::uuid`),
  );
  const row = rows[0];
  if (!row) throw new PayrollError(404, "not_found", "Payroll run was not found.");
  return row;
}

async function listItems(tx: TenantTx, runId: string): Promise<PayRunItemView[]> {
  const rows = queryRows<{
    id: string;
    employee_id: string;
    earnings_json: unknown;
    deductions_json: unknown;
    bpjs_json: unknown;
    pph21_json: unknown;
    gross_idr: string;
    tax_idr: string;
    net_idr: string;
    payslip_storage_key: string | null;
    payslip_generated_at: Date | string | null;
  }>(
    await tx.execute(sql`
      SELECT id::text AS id,
             employee_id::text AS employee_id,
             earnings_json,
             deductions_json,
             bpjs_json,
             pph21_json,
             gross_idr::text AS gross_idr,
             tax_idr::text AS tax_idr,
             net_idr::text AS net_idr,
             payslip_storage_key,
             payslip_generated_at
      FROM pay_run_items
      WHERE run_id = ${runId}::uuid
      ORDER BY employee_id
    `),
  );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    earnings: asJson(row.earnings_json) as StoredEarnings,
    deductions: asJson(row.deductions_json) as StoredDeductions,
    bpjs: asJson(row.bpjs_json) as StoredBpjs,
    pph21: asJson(row.pph21_json) as StoredPph21,
    grossIdr: row.gross_idr,
    taxIdr: row.tax_idr,
    netIdr: row.net_idr,
    payslipStorageKey: row.payslip_storage_key,
    payslipGeneratedAt: stamp(row.payslip_generated_at),
  }));
}

function toRun(row: RunRow): PayRunView {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    periodYearMonth: row.period_year_month,
    status: row.status,
    statutoryTableVersionId: row.statutory_table_version_id,
    totalGrossIdr: row.total_gross_idr,
    totalTaxIdr: row.total_tax_idr,
    totalNetIdr: row.total_net_idr,
    pdfBatchEnqueuedCount: Number(row.pdf_batch_enqueued_count),
    approvedBy: row.approved_by,
    approvedAt: stamp(row.approved_at),
    finalizedBy: row.finalized_by,
    finalizedAt: stamp(row.finalized_at),
  };
}

function stamp(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function audit(
  tx: TenantTx,
  caller: PayrollCaller,
  action: string,
  resourceId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await appendAuditEvent(tx, {
    tenantId: caller.tenantId,
    actorUserId: caller.userId,
    actorRole: caller.role,
    action,
    resourceType: "pay_run",
    resourceId,
    diff,
    aiProposalId: null,
    supportGrantId: null,
    ipAddress: caller.ipAddress,
    userAgent: caller.userAgent,
  });
}

function requireAny(caller: PayrollCaller, atoms: readonly string[], message: string): void {
  if (!atoms.some((atom) => hasPermission(caller, atom))) {
    throw new PayrollError(403, "forbidden", message);
  }
}

function readCreate(body: unknown): { legalEntityId: string; periodYearMonth: string } {
  const record = asRecord(body);
  const legalEntityId = record.legalEntityId;
  const periodYearMonth = record.periodYearMonth;
  if (typeof legalEntityId !== "string" || !UUID.test(legalEntityId)) {
    throw new PayrollError(400, "invalid_field", "legalEntityId must be a UUID.");
  }
  if (typeof periodYearMonth !== "string" || !parsePeriod(periodYearMonth)) {
    throw new PayrollError(400, "invalid_field", "periodYearMonth must be YYYY-MM.");
  }
  return { legalEntityId, periodYearMonth };
}

function readBank(body: unknown): { bank: BankBatchId; debitAccountNumber: string; effectiveDate: string | null } {
  const record = asRecord(body);
  const bank = record.bank;
  const debit = record.debitAccountNumber;
  const effective = record.effectiveDate;
  if (typeof bank !== "string" || !(bankBatchIds as readonly string[]).includes(bank)) {
    throw new PayrollError(400, "invalid_field", "bank must be bca-klikbisnis, mandiri-kopra, bni-direct, or bri-qlola.");
  }
  if (typeof debit !== "string" || !ACCOUNT.test(debit)) {
    throw new PayrollError(400, "invalid_field", "debitAccountNumber must be 8 to 18 digits.");
  }
  if (effective !== undefined && effective !== null && (typeof effective !== "string" || !ISO_DATE.test(effective))) {
    throw new PayrollError(400, "invalid_field", "effectiveDate must be YYYY-MM-DD.");
  }
  return {
    bank: bank as BankBatchId,
    debitAccountNumber: debit,
    effectiveDate: typeof effective === "string" ? effective : null,
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PayrollError(400, "invalid_field", "Request body must be an object.");
  }
  return body as Record<string, unknown>;
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new PayrollError(400, "invalid_field", `${label} must be a UUID.`);
}

function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new PayrollError(500, "internal_error", `${key} is missing from the snapshot.`);
  return value;
}

function yearOf(period: string): number {
  return Number(period.slice(0, 4));
}

function monthOf(period: string): number {
  return Number(period.slice(5, 7));
}

function periodEnd(period: string): string {
  const parsed = parsePeriod(period);
  if (!parsed) throw new PayrollError(500, "internal_error", "Stored period is not YYYY-MM.");
  return parsed.end;
}
