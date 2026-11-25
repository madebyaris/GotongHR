import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createFakeProvider, type FakeProvider } from "@gotonghr/ai";
import type { DomainActionExecutor } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
} from "@gotonghr/db";
import { migrateAudit } from "@gotonghr/audit";
import { migrateAi } from "@gotonghr/ai";
import { grantMembership, migrateIdentity } from "@gotonghr/identity";
import { migratePlatform } from "@gotonghr/platform";
import pg from "pg";
import { runBootstrap } from "./bootstrap.ts";
import { composeFromEnv, type ComposedApp } from "./composition.ts";
import { provisionQueue } from "./queue.ts";

const { Client } = pg;

const origin = "http://127.0.0.1:3000";
const ownerEmail = "slice51-owner@gotonghr.test";
const ownerPassword = "slice51-password-1";
const employeeEmail = "slice51-employee@gotonghr.test";
const employeePassword = "slice51-password-2";
const employeeId = "11111111-1111-4111-8111-111111111111";
const NIK = "3175012345670001";
const NPWP = "09.876.543.2-109.000";
const NPWP_PLAIN = "098765432109000";
const BANK = "123456789012";
const PHONE = "+6281234567890";
const LOCAL = "081298765432";
const EMAIL = "andi.hr@example.co.id";
const SALARY = "88888888";
const SAMPLES = [NIK, NPWP, NPWP_PLAIN, BANK, PHONE, LOCAL, EMAIL, SALARY];

loadRepoEnv();
applyDatabaseUrls(process.env);

describe("ai http", { concurrency: 1 }, () => {
  let composed: ComposedApp;
  let provider: FakeProvider;
  let tenantId = "";
  let ownerCookie = "";
  let employeeCookie = "";
  const executions: string[] = [];

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.LLM_PROVIDER = "fake";
    delete process.env.XAI_API_KEY;
    process.env.GOTONG_PII_KEK = "7a".repeat(32);
    process.env.GOTONG_DEPLOYMENT_MODE = "single_tenant";
    process.env.BETTER_AUTH_URL = origin;
    process.env.GOTONG_BOOTSTRAP_EMAIL = ownerEmail;
    process.env.GOTONG_BOOTSTRAP_PASSWORD = ownerPassword;
    process.env.GOTONG_BOOTSTRAP_TENANT_NAME = "GotongHR";
    process.env.GOTONG_BOOTSTRAP_OWNER_NAME = "Owner";
    process.env.STORAGE_DRIVER ??= "local";
    process.env.STORAGE_LOCAL_SECRET = "local-test-storage-secret-0123456789";
    process.env.QUEUE_DRIVER ??= "pgboss";
    process.env.GOTONG_AUTH_RATE_LIMIT_MAX = "100";
    process.env.GOTONG_AUTH_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.GOTONG_TRUST_PROXY = "1";
    process.env.GOTONG_TRUST_CLOUDFLARE = "false";
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateIdentity({
      superuserUrl: migrateEnv.superuserUrl,
      migratorUrl: migrateEnv.migratorUrl,
    });
    await migratePlatform({
      superuserUrl: migrateEnv.superuserUrl,
      migratorUrl: migrateEnv.migratorUrl,
    });
    await migrateAudit({ migratorUrl: migrateEnv.migratorUrl });
    await migrateAi({ migratorUrl: migrateEnv.migratorUrl });
    await provisionQueue(migrateEnv.migratorUrl);
    await resetIdentity();
    const created = await runBootstrap(process.env);
    tenantId = created.tenantId;
    provider = createFakeProvider();
    const domain: DomainActionExecutor = {
      async execute(command) {
        executions.push(command.proposalId);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { applied: true, proposalId: command.proposalId };
      },
    };
    composed = await composeFromEnv(process.env, { aiProvider: provider, aiDomain: domain });
    composedRef = composed;
    tenantRef = created.tenantId;
    await composed.appDb.pool.query("DELETE FROM id_rate_limits");
    await grantMembership(composed.auth, composed.appDb, {
      tenantId,
      email: employeeEmail,
      password: employeePassword,
      name: "Employee",
      role: "employee",
    });
    ownerCookie = await signedCookie(ownerEmail, ownerPassword);
    employeeCookie = await signedCookie(employeeEmail, employeePassword);
    ownerCookieRef = ownerCookie;
  });

  after(async () => {
    await composed?.close();
    const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await admin.connect();
    try {
      if (tenantId) {
        await admin.query("DELETE FROM ai_action_proposals WHERE tenant_id = $1", [tenantId]);
        await admin.query("DELETE FROM ai_messages WHERE tenant_id = $1", [tenantId]);
        await admin.query("DELETE FROM ai_conversations WHERE tenant_id = $1", [tenantId]);
        await admin.query("DELETE FROM aud_events WHERE tenant_id = $1", [tenantId]);
        await admin.query("DELETE FROM aud_tenant_keys WHERE tenant_id = $1", [tenantId]);
      }
    } finally {
      await admin.end();
    }
    await resetIdentity();
  });

  it("requires a tenant member", async () => {
    const response = await composed.app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: { origin, "content-type": "application/json" },
      payload: { message: "Hello" },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(readCode(response.body), "unauthenticated");
  });

  it("does not let an employee read another salary or call a privileged tool", async () => {
    const response = await chat(employeeCookie, "What is their pay?", [
      {
        toolCalls: [
          {
            name: "simulate_payroll_item",
            arguments: {
              employeeId,
              payrollDate: "2026-01-31",
              periodMonth: 1,
              ptkpStatus: "TK/0",
              method: "gross",
              baseSalaryIdr: SALARY,
            },
          },
        ],
      },
      { text: "No." },
    ]);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes(SALARY), false);
    assert.equal(response.body.includes("forbidden"), true);
    const related = provider.requests.filter((request) =>
      request.messages.some((message) => message.content.includes("What is their pay?")),
    );
    assert.equal(related.length > 0, true);
    assert.equal(JSON.stringify(related).includes(SALARY), false);
    assert.equal(related.some((request) => request.tools.some((tool) => tool.name === "simulate_payroll_item")), false);
    assert.equal(executions.length, 0);
  });

  it("redacts outbound text and confirms a proposal exactly once", async () => {
    const employeesBefore = await employeeVaultState();
    const created = await ownerProposal(
      `NIK ${NIK}. NPWP ${NPWP}. plain ${NPWP_PLAIN}. rekening ${BANK}. ${PHONE} ${LOCAL} ${EMAIL}`,
    );
    assertNoSamples(JSON.stringify(provider.requests));
    assert.equal(JSON.stringify(provider.requests).includes(created.nonce), false);
    assertNoSamples(await persistedText());
    assert.equal((await persistedText()).includes(created.nonce), false);

    const listed = await composed.app.inject({
      method: "GET",
      url: "/api/v1/ai/proposals",
      headers: { origin, cookie: ownerCookie },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.body.includes(created.nonce), false);
    assert.equal(listed.body.includes("confirmationNonce"), false);

    const employeeRead = await composed.app.inject({
      method: "GET",
      url: `/api/v1/ai/proposals/${created.id}`,
      headers: { origin, cookie: employeeCookie },
    });
    assert.equal(employeeRead.statusCode, 404);

    const wrongUser = await confirm(employeeCookie, created.id, created.nonce);
    assert.equal(wrongUser.statusCode, 403);
    assert.equal(executions.includes(created.id), false);

    const wrongNonce = await confirm(ownerCookie, created.id, "wrong-nonce");
    assert.equal(wrongNonce.statusCode, 400);
    assert.equal(executions.includes(created.id), false);

    const expired = await ownerProposal("Set the display name again.");
    await expire(expired.id);
    const expiredResponse = await confirm(ownerCookie, expired.id, expired.nonce);
    assert.equal(expiredResponse.statusCode, 409);
    assert.equal(executions.includes(expired.id), false);
    const expiredRow = await statusOf(expired.id);
    assert.equal(expiredRow, "expired");

    const live = await ownerProposal("Set the display name once more.");
    const okResponse = await confirm(ownerCookie, live.id, live.nonce);
    assert.equal(okResponse.statusCode, 200, okResponse.body);
    assert.equal(readData(okResponse.body).status, "executed");
    assert.equal(okResponse.body.includes(live.nonce), false);
    assert.equal(executions.filter((id) => id === live.id).length, 1);
    const second = await confirm(ownerCookie, live.id, live.nonce);
    assert.equal(second.statusCode, 409);
    assert.equal(executions.filter((id) => id === live.id).length, 1);

    const raced = await ownerProposal("Set the display name together.");
    const [first, other] = await Promise.all([
      confirm(ownerCookie, raced.id, raced.nonce),
      confirm(ownerCookie, raced.id, raced.nonce),
    ]);
    const codes = [first.statusCode, other.statusCode].sort();
    assert.deepEqual(codes, [200, 409]);
    assert.equal(executions.filter((id) => id === raced.id).length, 1);

    const rejected = await ownerProposal("Set the display name, then stop.");
    const rejection = await composed.app.inject({
      method: "POST",
      url: `/api/v1/ai/proposals/${rejected.id}/reject`,
      headers: { origin, cookie: ownerCookie },
    });
    assert.equal(rejection.statusCode, 200, rejection.body);
    const again = await composed.app.inject({
      method: "POST",
      url: `/api/v1/ai/proposals/${rejected.id}/reject`,
      headers: { origin, cookie: ownerCookie },
    });
    assert.equal(again.statusCode, 409);
    assert.equal(executions.includes(rejected.id), false);

    assert.deepEqual(await employeeVaultState(), employeesBefore);
    assertNoSamples(await persistedText());
  });
});

async function ownerProposal(message: string): Promise<{ id: string; nonce: string }> {
  const response = await chat(ownerCookieRef, message, [
    {
      toolCalls: [
        {
          name: "propose_employee_change",
          arguments: { employeeId, field: "display_name", value: "Sari" },
        },
      ],
    },
    { text: "Waiting." },
  ]);
  assert.equal(response.statusCode, 200, response.body);
  assertNoSamples(response.body);
  const proposal = readData(response.body).proposals?.[0];
  if (!proposal?.id || !proposal.confirmationNonce) throw new Error("proposal was not created");
  return { id: proposal.id, nonce: proposal.confirmationNonce };
}

function chat(
  cookie: string,
  message: string,
  fakeScript: Array<{ text?: string; toolCalls?: Array<{ name: string; arguments?: unknown }> }>,
) {
  return composedApp().inject({
    method: "POST",
    url: "/api/v1/ai/chat",
    headers: { origin, cookie, "content-type": "application/json" },
    payload: { message, fakeScript },
  });
}

function confirm(cookie: string, id: string, confirmationNonce: string) {
  return composedApp().inject({
    method: "POST",
    url: `/api/v1/ai/proposals/${id}/confirm`,
    headers: { origin, cookie, "content-type": "application/json" },
    payload: { confirmationNonce },
  });
}

let composedRef: ComposedApp | undefined;

function composedApp() {
  if (!composedRef) throw new Error("app is not ready");
  return composedRef.app;
}

async function signedCookie(email: string, password: string): Promise<string> {
  const response = await composedApp().inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin, "content-type": "application/json" },
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const header = response.headers["set-cookie"];
  const lines = typeof header === "string" ? [header] : (header ?? []).map(String);
  return lines
    .map((line) => line.split(";")[0]?.trim() ?? "")
    .filter((part) => part.includes("="))
    .join("; ");
}

function readCode(body: string): string | undefined {
  return (JSON.parse(body) as { error?: { code?: string } | null }).error?.code;
}

function readData(body: string): {
  status?: string;
  proposals?: Array<{ id: string; confirmationNonce: string }>;
} {
  return (JSON.parse(body) as { data: { status?: string; proposals?: Array<{ id: string; confirmationNonce: string }> } }).data;
}

async function persistedText(): Promise<string> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    const messages = await admin.query("SELECT content_redacted, tool_calls_json::text AS tools, title FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id WHERE m.tenant_id = $1", [currentTenant()]);
    const proposals = await admin.query("SELECT arguments_json::text AS arguments, impact_preview_json::text AS impact, confirmation_nonce, execution_result_json::text AS result FROM ai_action_proposals WHERE tenant_id = $1", [currentTenant()]);
    const audit = await admin.query("SELECT diff_redacted_json::text AS diff, action FROM aud_events WHERE tenant_id = $1", [currentTenant()]);
    return JSON.stringify({ messages: messages.rows, proposals: proposals.rows, audit: audit.rows });
  } finally {
    await admin.end();
  }
}

async function expire(id: string): Promise<void> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    await admin.query("UPDATE ai_action_proposals SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
  } finally {
    await admin.end();
  }
}

async function statusOf(id: string): Promise<string | null> {
  return statusQuery("SELECT status FROM ai_action_proposals WHERE id = $1", [id]);
}

async function employeeVaultState(): Promise<{ name: string | null; rows: number }> {
  const name = await statusQuery("SELECT to_regclass('hr_employees')::text AS status");
  if (!name) return { name: null, rows: 0 };
  const rows = Number(await statusQuery("SELECT count(*)::text AS status FROM hr_employees"));
  return { name, rows };
}

async function statusQuery(text: string, params: string[] = []): Promise<string | null> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    const result = await admin.query<{ status: string | null }>(text, params);
    return result.rows[0]?.status ?? null;
  } finally {
    await admin.end();
  }
}

function assertNoSamples(text: string): void {
  for (const sample of SAMPLES) assert.equal(text.includes(sample), false, sample);
}

let tenantRef = "";
let ownerCookieRef = "";

function currentTenant(): string {
  if (!tenantRef) throw new Error("tenant is not ready");
  return tenantRef;
}

async function resetIdentity(): Promise<void> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    await admin.query(`
      TRUNCATE TABLE
        id_branches,
        id_legal_entities,
        id_sessions,
        id_memberships,
        id_users,
        id_roles,
        id_tenants,
        id_rate_limits,
        ba_two_factor,
        ba_invitation,
        ba_member,
        ba_session,
        ba_account,
        ba_verification,
        ba_organization,
        ba_user
      CASCADE
    `);
  } finally {
    await admin.end();
  }
}
