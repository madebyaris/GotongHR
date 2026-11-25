import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { AuditEventDraft, DomainActionExecutor } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { parseStatutoryTable, type StatutoryTable } from "@gotonghr/payroll-engine";
import { sql } from "drizzle-orm";
import pg from "pg";
import type { AiCaller } from "./caller.ts";
import { migrateAi } from "./migrate.ts";
import { createFakeProvider } from "./provider.ts";
import { createAiRuntime, type AiRuntime } from "./service.ts";
import { rowsOf } from "./store.ts";

const { Client } = pg;

const NIK = "3175012345670001";
const NPWP = "09.876.543.2-109.000";
const NPWP_PLAIN = "098765432109000";
const BANK = "123456789012";
const PHONE = "+6281234567890";
const LOCAL = "081298765432";
const EMAIL = "andi.hr@example.co.id";
const SALARY = "88888888";
const SAMPLES = [NIK, NPWP, NPWP_PLAIN, BANK, PHONE, LOCAL, EMAIL];

const employeeId = "11111111-1111-4111-8111-111111111111";
const meta = { ipAddress: null, userAgent: null };

loadRepoEnv();
applyDatabaseUrls(process.env);

describe("ai assistant", { concurrency: 1 }, () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  let app: TenantDatabase;
  let platform: pg.Client;
  let superuser: pg.Client;

  before(async () => {
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateAi({ migratorUrl: migrateEnv.migratorUrl });
    app = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
  });

  after(async () => {
    await superuser.query("DELETE FROM ai_messages WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await superuser.query("DELETE FROM ai_action_proposals WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await superuser.query("DELETE FROM ai_conversations WHERE tenant_id = ANY($1::uuid[])", [[tenantA, tenantB]]);
    await app.end();
    await platform.end();
    await superuser.end();
  });

  it("isolates tenants and denies platform_admin", async () => {
    await app.withTenantContext(tenantA, async (tx) => {
      await tx.execute(sql`
        INSERT INTO ai_conversations (tenant_id, created_by_user_id, title)
        VALUES (${tenantA}::uuid, ${userA}::uuid, 'tenant-a')
      `);
    });
    await app.withTenantContext(tenantB, async (tx) => {
      const visible = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id::text AS id FROM ai_conversations`),
      );
      assert.equal(visible.length, 0);
    });
    const bare = await app.pool.query("SELECT id FROM ai_conversations");
    assert.equal(bare.rows.length, 0);
    await assert.rejects(
      app.pool.query(
        "INSERT INTO ai_conversations (tenant_id, created_by_user_id, title) VALUES ($1, $2, 'x')",
        [tenantA, userA],
      ),
      isDenied,
    );
    await assert.rejects(platform.query("SELECT id FROM ai_conversations"), isDenied);
    await assert.rejects(
      platform.query(
        "INSERT INTO ai_conversations (tenant_id, created_by_user_id, title) VALUES ($1, $2, 'x')",
        [tenantA, userA],
      ),
      isDenied,
    );
    const privileges = await superuser.query<{ select: boolean; insert: boolean }>(
      `SELECT has_table_privilege('platform_admin', 'ai_action_proposals', 'SELECT') AS select,
              has_table_privilege('platform_admin', 'ai_action_proposals', 'INSERT') AS insert`,
    );
    assert.equal(privileges.rows[0]?.select, false);
    assert.equal(privileges.rows[0]?.insert, false);
    const version = await superuser.query<{ id: string }>(
      "SELECT id::text AS id FROM ai_conversations WHERE tenant_id = $1",
      [tenantA],
    );
    assert.equal(version.rows[0]?.id.split("-")[2]?.[0], "7");
  });

  it("keeps raw PII off the provider, the tables, and the audit log", async () => {
    const harness = harnessFor(app);
    const privileged = hrCaller(tenantA, userA, true);
    const chat = await harness.runtime.chat(
      privileged,
      {
        message: `NIK ${NIK}. NPWP ${NPWP}. plain ${NPWP_PLAIN}. rekening ${BANK}. ${PHONE} ${LOCAL} ${EMAIL}`,
        script: [
          {
            toolCalls: [
              {
                name: "propose_employee_change",
                arguments: { employeeId, field: "display_name", value: `Sari ${EMAIL}` },
              },
            ],
          },
          { text: "Saved [EMP_01_EMAIL] and [EMP_01_NIK]." },
        ],
      },
      meta,
    );
    assert.equal(chat.ok, true);
    if (!chat.ok) return;
    assert.equal(chat.data.message.includes(EMAIL), true);
    assert.equal(chat.data.message.includes(NIK), true);
    assert.equal(harness.executions.length, 0);
    const nonce = chat.data.proposals[0]?.confirmationNonce;
    assert.equal(typeof nonce, "string");
    assertNoSamples(JSON.stringify(harness.provider.requests));
    assert.equal(JSON.stringify(harness.provider.requests).includes(nonce ?? ""), false);
    assertNoSamples(JSON.stringify(harness.auditEvents));
    assertNoSamples(JSON.stringify(harness.logs));
    const stored = await storedText(app, tenantA);
    assertNoSamples(stored);
    assert.equal(stored.includes(nonce ?? ""), false);
    const digest = await superuser.query<{ confirmation_nonce: string; expires_at: Date }>(
      "SELECT confirmation_nonce, expires_at FROM ai_action_proposals WHERE id = $1",
      [chat.data.proposals[0]?.id],
    );
    assert.match(digest.rows[0]?.confirmation_nonce ?? "", /^[0-9a-f]{64}$/u);
    assert.notEqual(digest.rows[0]?.confirmation_nonce, nonce);
    const ttl = new Date(digest.rows[0]?.expires_at ?? 0).getTime() - Date.now();
    assert.equal(ttl > 14 * 60_000 && ttl < 16 * 60_000, true);

    const hidden = await harness.runtime.chat(
      hrCaller(tenantA, userA, false),
      {
        message: `Email ${EMAIL}`,
        script: [{ text: "Saved [EMP_01_EMAIL]." }],
      },
      meta,
    );
    assert.equal(hidden.ok, true);
    if (!hidden.ok) return;
    assert.equal(hidden.data.message.includes(EMAIL), false);
    assert.match(hidden.data.message, /\[EMP_01_EMAIL\]/u);
  });

  it("confirms a proposal once and rejects every other confirm", async () => {
    const harness = harnessFor(app);
    const owner = hrCaller(tenantA, userA, true);
    const other = hrCaller(tenantA, userB, true);
    const created = await propose(harness.runtime, owner);
    assert.equal(harness.executions.length, 0);
    const wrongUser = await harness.runtime.confirmProposal(other, created.id, created.nonce, meta);
    assert.equal(wrongUser.ok, false);
    if (wrongUser.ok) return;
    assert.equal(wrongUser.status, 403);
    const wrongNonce = await harness.runtime.confirmProposal(owner, created.id, "not-the-nonce", meta);
    assert.equal(wrongNonce.ok, false);
    if (wrongNonce.ok) return;
    assert.equal(wrongNonce.status, 400);
    assert.equal(harness.executions.length, 0);

    const expired = await propose(harness.runtime, owner);
    await superuser.query("UPDATE ai_action_proposals SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      expired.id,
    ]);
    const expiredResult = await harness.runtime.confirmProposal(owner, expired.id, expired.nonce, meta);
    assert.equal(expiredResult.ok, false);
    if (expiredResult.ok) return;
    assert.equal(expiredResult.status, 409, JSON.stringify(expiredResult));
    const expiredRow = await superuser.query<{ status: string }>(
      "SELECT status FROM ai_action_proposals WHERE id = $1",
      [expired.id],
    );
    assert.equal(expiredRow.rows[0]?.status, "expired");
    assert.equal(harness.executions.includes(expired.id), false);

    const live = await propose(harness.runtime, owner);
    const confirmed = await harness.runtime.confirmProposal(owner, live.id, live.nonce, meta);
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) return;
    assert.equal(confirmed.data.status, "executed");
    assert.equal(harness.executions.filter((id) => id === live.id).length, 1);
    const again = await harness.runtime.confirmProposal(owner, live.id, live.nonce, meta);
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.status, 409);
    assert.equal(harness.executions.filter((id) => id === live.id).length, 1);

    const raced = await propose(harness.runtime, owner);
    const [first, second] = await Promise.all([
      harness.runtime.confirmProposal(owner, raced.id, raced.nonce, meta),
      harness.runtime.confirmProposal(owner, raced.id, raced.nonce, meta),
    ]);
    const statuses = [first, second].map((result) => (result.ok ? 200 : result.status)).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(harness.executions.filter((id) => id === raced.id).length, 1);

    const rejected = await propose(harness.runtime, owner);
    const rejection = await harness.runtime.rejectProposal(owner, rejected.id, meta);
    assert.equal(rejection.ok, true);
    const secondReject = await harness.runtime.rejectProposal(owner, rejected.id, meta);
    assert.equal(secondReject.ok, false);
    if (secondReject.ok) return;
    assert.equal(secondReject.status, 409);
    assert.equal(harness.executions.includes(rejected.id), false);
    const employees = await superuser.query<{ name: string | null }>("SELECT to_regclass('hr_employees')::text AS name");
    assert.equal(employees.rows[0]?.name ?? null, null);
  });

  it("simulates with the payroll engine and hides another salary from an employee", async () => {
    const table = syntheticTable();
    const harness = harnessFor(app, table);
    const hr = hrCaller(tenantA, userA, true);
    const simulated = await harness.runtime.chat(
      hr,
      {
        message: "Estimate January.",
        script: [{ toolCalls: [{ name: "simulate_payroll_item", arguments: simulateArgs(employeeId) }] }, { text: "Done." }],
      },
      meta,
    );
    assert.equal(simulated.ok, true);
    if (!simulated.ok) return;
    const result = simulated.data.toolResults[0]?.result as { taxIdr?: string };
    assert.equal(result.taxIdr, "100000");

    const employee = employeeCaller(tenantA, userB);
    const denied = await harness.runtime.chat(
      employee,
      {
        message: "What is their pay?",
        script: [
          {
            toolCalls: [
              {
                name: "simulate_payroll_item",
                arguments: { ...simulateArgs(employeeId), baseSalaryIdr: SALARY },
              },
            ],
          },
          { text: "No." },
        ],
      },
      meta,
    );
    assert.equal(denied.ok, true);
    if (!denied.ok) return;
    const body = JSON.stringify(denied.data);
    assert.equal(body.includes(SALARY), false);
    assert.equal(JSON.stringify(denied.data.toolResults).includes("forbidden"), true);
    const offered = harness.provider.requests.filter((request) =>
      request.messages.some((message) => message.content === "What is their pay?"),
    );
    assert.equal(offered.some((request) => request.tools.some((tool) => tool.name === "simulate_payroll_item")), false);
    assert.equal(JSON.stringify(offered).includes(SALARY), false);
    assert.equal((await storedText(app, tenantA)).includes(SALARY), false);
  });

  it("streams redacted tokens and stops when the client disconnects", async () => {
    const harness = harnessFor(app);
    let streams = 0;
    const original = harness.provider.stream.bind(harness.provider);
    harness.provider.stream = (request, signal) => {
      streams += 1;
      return original(request, signal);
    };
    const events = [];
    for await (const event of harness.runtime.chatStream(
      hrCaller(tenantA, userA, false),
      {
        message: `NIK ${NIK}. Update the card.`,
        script: [
          {
            text: `Ready ${NIK}`,
            toolCalls: [
              {
                name: "propose_employee_change",
                arguments: { employeeId, field: "display_name", value: "Sari" },
              },
            ],
          },
        ],
      },
      meta,
    )) {
      events.push(event);
    }
    assert.equal(streams > 0, true);
    assert.equal(events.some((event) => event.type === "token"), true);
    assert.equal(events.some((event) => event.type === "tool"), true);
    assert.equal(events.some((event) => event.type === "proposal"), true);
    assert.equal(events.at(-1)?.type, "done");
    assertNoSamples(JSON.stringify(events));
    const proposal = events.find((event) => event.type === "proposal");
    assert.equal(proposal?.type, "proposal");
    if (proposal?.type !== "proposal") return;
    assert.equal(typeof proposal.proposal.confirmationNonce, "string");
    assert.equal(JSON.stringify(proposal.proposal.impactPreview).includes(NIK), false);

    const controller = new AbortController();
    let released = false;
    harness.provider.stream = async function* stream() {
      yield { type: "text" as const, text: `${"a".repeat(80)} ` };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      released = true;
      yield { type: "text" as const, text: NIK };
      yield { type: "done" as const };
    };
    const iterator = harness.runtime.chatStream(
      hrCaller(tenantA, userA, false),
      { message: "Stop this reply.", script: [{ text: "unused" }] },
      meta,
      controller.signal,
    );
    const first = await iterator.next();
    assert.equal(first.value?.type, "token");
    controller.abort();
    const rest = [];
    for await (const event of iterator) rest.push(event);
    assert.equal(released, true);
    assert.equal(JSON.stringify(rest).includes(NIK), false);
    assert.equal(rest.some((event) => event.type === "done"), false);
  });

  it("keeps payroll finalize pending until the authenticator is verified", async () => {
    const harness = harnessFor(app);
    const owner = {
      ...hrCaller(tenantA, userA, false),
      role: "org_owner",
      permissions: ["payroll.run.finalize", "ai.action.approve", "employee.pii.read"] as const,
    };
    const proposed = await harness.runtime.chat(
      owner,
      {
        message: "Finalize January.",
        script: [
          {
            toolCalls: [
              {
                name: "propose_payroll_finalize",
                arguments: {
                  payrollRunId: "55555555-5555-4555-8555-555555555555",
                  periodLabel: "2026-01",
                  netPayIdr: "15000000",
                },
              },
            ],
          },
        ],
      },
      meta,
    );
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const proposal = proposed.data.proposals[0];
    assert.equal(proposal?.requiresTotp, true);
    if (!proposal?.confirmationNonce) throw new Error("proposal nonce missing");
    const denied = await harness.runtime.confirmProposal(owner, proposal.id, proposal.confirmationNonce, meta);
    assert.equal(denied.ok, false);
    if (denied.ok) return;
    assert.equal(denied.code, "totp_verification_required");
    assert.equal(harness.executions.length, 0);
    const allowed = await harness.runtime.confirmProposal(
      { ...owner, sessionTotpVerified: true },
      proposal.id,
      proposal.confirmationNonce,
      meta,
    );
    assert.equal(allowed.ok, true);
    if (!allowed.ok) return;
    assert.equal(allowed.data.status, "executed");
    assert.equal(harness.executions.length, 1);
    const thread = await harness.runtime.readLatest(owner);
    assert.equal(thread.ok, true);
    if (!thread.ok) return;
    assert.equal(thread.data.proposals.some((item) => item.id === proposal.id && item.status === "executed"), true);
    assert.equal(JSON.stringify(thread.data).includes("15000000"), true);
    assertNoSamples(JSON.stringify(thread.data));
  });
});

function syntheticTable(): StatutoryTable {
  const file = new URL("../../../payroll-engine/src/__tests__/fixtures/synthetic-pph21.json", import.meta.url);
  return parseStatutoryTable(JSON.parse(readFileSync(file, "utf8")));
}

function simulateArgs(target: string) {
  return {
    employeeId: target,
    payrollDate: "2026-01-31",
    periodMonth: 1,
    ptkpStatus: "TK/0",
    method: "gross",
    baseSalaryIdr: "5000000",
  };
}

function hrCaller(tenantId: string, userId: string, totp: boolean): AiCaller {
  return {
    tenantId,
    userId,
    role: "hr_admin",
    permissions: ["employee.pii.read", "payroll.run.prepare", "ai.action.approve"],
    scopeEntityIds: [],
    scopeBranchIds: [],
    directReportsOnly: false,
    selfOnly: false,
    selfEmployeeId: null,
    sessionTotpVerified: totp,
  };
}

function employeeCaller(tenantId: string, userId: string): AiCaller {
  return {
    tenantId,
    userId,
    role: "employee",
    permissions: [],
    scopeEntityIds: [],
    scopeBranchIds: [],
    directReportsOnly: false,
    selfOnly: true,
    selfEmployeeId: null,
    sessionTotpVerified: false,
  };
}

function harnessFor(database: TenantDatabase, table?: StatutoryTable) {
  const provider = createFakeProvider();
  const executions: string[] = [];
  const logs: unknown[] = [];
  const auditEvents: AuditEventDraft[] = [];
  const domain: DomainActionExecutor = {
    async execute(command) {
      executions.push(command.proposalId);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { applied: true, proposalId: command.proposalId };
    },
  };
  const runtime = createAiRuntime({
    database,
    provider,
    domain,
    audit: {
      append(_tx, event) {
        auditEvents.push(event);
        return Promise.resolve();
      },
    },
    log(event) {
      logs.push(event);
    },
    ...(table ? { loadTable: () => table } : {}),
  });
  return { provider, executions, logs, auditEvents, runtime };
}

async function propose(runtime: AiRuntime, caller: AiCaller): Promise<{ id: string; nonce: string }> {
  const chat = await runtime.chat(
    caller,
    {
      message: "Update the display name.",
      script: [
        {
          toolCalls: [
            {
              name: "propose_employee_change",
              arguments: { employeeId, field: "display_name", value: "Sari" },
            },
          ],
        },
        { text: "Waiting." },
      ],
    },
    meta,
  );
  assert.equal(chat.ok, true);
  if (!chat.ok) throw new Error("proposal was not created");
  const proposal = chat.data.proposals[0];
  if (!proposal?.confirmationNonce) throw new Error("proposal nonce missing");
  return { id: proposal.id, nonce: proposal.confirmationNonce };
}

async function storedText(database: TenantDatabase, tenantId: string): Promise<string> {
  return database.withTenantContext(tenantId, async (tx) => {
    const messages = rowsOf<{ body: string }>(
      await tx.execute(sql`
        SELECT content_redacted || coalesce(tool_calls_json::text, '') AS body
        FROM ai_messages
      `),
    );
    const proposals = rowsOf<{ body: string }>(
      await tx.execute(sql`
        SELECT arguments_json::text || impact_preview_json::text || coalesce(execution_result_json::text, '') AS body
        FROM ai_action_proposals
      `),
    );
    const titles = rowsOf<{ body: string | null }>(
      await tx.execute(sql`SELECT title AS body FROM ai_conversations`),
    );
    return JSON.stringify({ messages, proposals, titles });
  });
}

function assertNoSamples(text: string): void {
  for (const sample of SAMPLES) assert.equal(text.includes(sample), false, sample);
  assert.equal(/\b\d{16}\b/u.test(text), false);
}

function isDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const current = error as { code?: string; cause?: unknown };
  if (current.code === "42501") return true;
  return isDenied(current.cause);
}
