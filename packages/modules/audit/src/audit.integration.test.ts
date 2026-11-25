import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { blindIndex, encryptField, maskNik } from "@gotonghr/crypto";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  grantSchemaDml,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  QUEUE_ROLE,
  QUEUE_SCHEMA,
  requiredEnv,
  tenantIsolationPolicySql,
  type TenantDatabase,
  type TenantTx,
} from "@gotonghr/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { dispatchOutboxOnce, OUTBOX_QUEUE } from "./dispatcher.ts";
import { PiiRevealDeniedError, PiiRevealReasonError } from "./errors.ts";
import { provisionTenantKeys, readTenantSecrets } from "./keys.ts";
import { migrateAudit } from "./migrate.ts";
import { auditedUpdate } from "./mutation.ts";
import { enqueueOutboxEvent } from "./outbox.ts";
import { asCiphertext, revealPii } from "./reveal.ts";
import { queryRows, quoteIdentifier } from "./sql.ts";
import { verifyTenantHashChain } from "./verify.ts";

const { Client } = pg;

loadRepoEnv();
applyDatabaseUrls(process.env);
process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";

const TEST_KEK = { ...process.env, GOTONG_PII_KEK: process.env.GOTONG_PII_KEK, AUDIT_HASH_CHAIN: "on" };
const nik = "3273011508950001";

function permissionDenied(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const row = current as { code?: string; message?: string; cause?: unknown };
    if (row.code === "42501" && /permission denied/i.test(row.message ?? "")) return true;
    current = row.cause;
  }
  return false;
}

async function countOf(tx: TenantTx, table: string): Promise<number> {
  quoteIdentifier(table);
  const rows = queryRows<{ n: number | string }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(quoteIdentifier(table))}`),
  );
  return Number(rows[0]?.n ?? 0);
}

async function provisionBoss(migratorUrl: string): Promise<void> {
  const lock = new Client({ connectionString: migratorUrl });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", ["gotonghr.queue.provision"]);
    const boss = new PgBoss({
      connectionString: migratorUrl,
      schema: QUEUE_SCHEMA,
      createSchema: true,
      migrate: true,
    });
    await boss.start();
    try {
      const existing = await boss.getQueue(OUTBOX_QUEUE);
      if (!existing) {
        await boss.createQueue(OUTBOX_QUEUE, { deleteAfterSeconds: 7 * 24 * 60 * 60 });
      }
      await grantSchemaDml(migratorUrl, QUEUE_SCHEMA, QUEUE_ROLE);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", ["gotonghr.queue.provision"]).catch(() => undefined);
    await lock.end();
  }
}

describe("audit, outbox, and PII crypto", { concurrency: 1 }, () => {
  let app: TenantDatabase;
  let platform: pg.Client;
  let superuser: pg.Client;
  const migratorUrl = requiredEnv(process.env, "DATABASE_URL_MIGRATOR");

  before(async () => {
    await migrate(migrateEnvFrom(process.env));
    await migrateAudit({ migratorUrl });
    await provisionBoss(migratorUrl);
    const migrator = new Client({ connectionString: migratorUrl });
    await migrator.connect();
    try {
      await migrator.query(`
        CREATE TABLE IF NOT EXISTS aud_mutation_fixture (
          id uuid PRIMARY KEY DEFAULT uuidv7(),
          tenant_id uuid NOT NULL,
          label text NOT NULL,
          nik text,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await migrator.query(tenantIsolationPolicySql("aud_mutation_fixture"));
      await migrator.query("REVOKE ALL ON TABLE aud_mutation_fixture FROM PUBLIC");
      await migrator.query("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE aud_mutation_fixture TO app_tenant");
    } finally {
      await migrator.end();
    }
    app = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
  });

  after(async () => {
    await superuser.query("DROP TABLE IF EXISTS aud_mutation_fixture");
    await app.end();
    await platform.end();
    await superuser.end();
  });

  it("masks a 16-digit NIK without the middle digits", () => {
    const masked = maskNik(nik);
    assert.equal(masked, "3273********0001");
    assert.equal(masked.includes("01150895"), false);
  });

  it("rejects app_tenant and platform_admin writes on the append-only tables", async () => {
    const tenant = randomUUID();
    const actor = randomUUID();
    await app.withTenantContext(tenant, async (tx) => {
      await tx.execute(sql`
        INSERT INTO aud_events (tenant_id, actor_user_id, action, resource_type, diff_redacted_json)
        VALUES (
          ${tenant}::uuid,
          ${actor}::uuid,
          'create',
          'probe',
          '{"before":null,"after":{"label":"ok"}}'::jsonb
        )
      `);
      await tx.execute(sql`
        INSERT INTO aud_pii_access_logs (
          tenant_id, actor_user_id, field_name, resource_type, resource_id, reason
        ) VALUES (
          ${tenant}::uuid,
          ${actor}::uuid,
          'nik',
          'hr_employee_pii',
          ${randomUUID()}::uuid,
          'seed'
        )
      `);
      assert.equal(await countOf(tx, "aud_events"), 1);
      assert.equal(await countOf(tx, "aud_pii_access_logs"), 1);
    });

    for (const statement of [
      "UPDATE aud_events SET action = action",
      "DELETE FROM aud_events",
      "TRUNCATE aud_events",
      "UPDATE aud_pii_access_logs SET reason = reason",
      "DELETE FROM aud_pii_access_logs",
      "TRUNCATE aud_pii_access_logs",
    ]) {
      await assert.rejects(app.pool.query(statement), permissionDenied, statement);
      await assert.rejects(platform.query(statement), permissionDenied, statement);
    }
  });

  it("stores a redacted diff and a hash chain that detects tampering", async () => {
    const tenant = randomUUID();
    const actor = randomUUID();
    let firstId = "";
    let secondId = "";
    await app.withTenantContext(tenant, async (tx) => {
      await provisionTenantKeys(tx, tenant, TEST_KEK);
      const inserted = queryRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO aud_mutation_fixture (tenant_id, label, nik)
          VALUES (${tenant}::uuid, 'before', ${nik})
          RETURNING id::text AS id
        `),
      );
      const resourceId = inserted[0]?.id;
      assert.ok(resourceId);
      const first = await auditedUpdate(tx, {
        table: "aud_mutation_fixture",
        tenantId: tenant,
        resourceId,
        action: "update",
        resourceType: "aud_mutation_fixture",
        actorUserId: actor,
        actorRole: "hr_admin",
        assignments: { label: "middle", nik: "3273011508950002" },
      }, TEST_KEK);
      firstId = first.eventId;
      assert.equal(first.before.label, "before");
      assert.equal(first.after.label, "middle");
      const second = await auditedUpdate(tx, {
        table: "aud_mutation_fixture",
        tenantId: tenant,
        resourceId,
        action: "update",
        resourceType: "aud_mutation_fixture",
        actorUserId: actor,
        assignments: { label: "after" },
      }, TEST_KEK);
      secondId = second.eventId;
      const verified = await verifyTenantHashChain(tx, tenant);
      assert.deepEqual(verified, { ok: true, chained: true, events: 2 });
      const stored = queryRows<{
        id: string;
        prev_hash: string;
        event_hash: string;
        diff_redacted_json: { before: { nik?: string; label?: string }; after: { nik?: string; label?: string } };
      }>(
        await tx.execute(sql`
          SELECT id::text AS id, prev_hash, event_hash, diff_redacted_json
          FROM aud_events
          WHERE tenant_id = ${tenant}::uuid
          ORDER BY created_at, id
        `),
      );
      assert.equal(stored[0]?.id, firstId);
      assert.equal(stored[1]?.id, secondId);
      assert.equal(stored[1]?.prev_hash, stored[0]?.event_hash);
      assert.equal(stored[0]?.diff_redacted_json.before.nik, "[redacted]");
      assert.equal(stored[0]?.diff_redacted_json.after.nik, "[redacted]");
      assert.equal(stored[0]?.diff_redacted_json.before.label, "before");
      assert.equal(stored[0]?.diff_redacted_json.after.label, "middle");
      const body = JSON.stringify(stored);
      assert.equal(body.includes(nik), false);
      assert.equal(body.includes("3273011508950002"), false);
    });

    await superuser.query(
      `UPDATE aud_events
       SET diff_redacted_json = '{"before":{"label":"tampered"},"after":{"label":"middle"}}'::jsonb
       WHERE id = $1::uuid`,
      [firstId],
    );
    await app.withTenantContext(tenant, async (tx) => {
      const verified = await verifyTenantHashChain(tx, tenant);
      assert.equal(verified.ok, false);
      if (!verified.ok) assert.equal(verified.eventId, firstId);
    });
  });

  it("leaves the hash columns null when the tenant chain is off", async () => {
    const tenant = randomUUID();
    const actor = randomUUID();
    const off = { ...TEST_KEK, AUDIT_HASH_CHAIN: "off" };
    await app.withTenantContext(tenant, async (tx) => {
      const created = await provisionTenantKeys(tx, tenant, off);
      assert.equal(created.created, true);
      const inserted = queryRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO aud_mutation_fixture (tenant_id, label, nik)
          VALUES (${tenant}::uuid, 'plain', 'no-chain')
          RETURNING id::text AS id
        `),
      );
      const resourceId = inserted[0]?.id;
      assert.ok(resourceId);
      await auditedUpdate(tx, {
        table: "aud_mutation_fixture",
        tenantId: tenant,
        resourceId,
        action: "update",
        resourceType: "aud_mutation_fixture",
        actorUserId: actor,
        assignments: { label: "still" },
      }, off);
      const rows = queryRows<{ prev_hash: string | null; event_hash: string | null }>(
        await tx.execute(sql`
          SELECT prev_hash, event_hash FROM aud_events WHERE tenant_id = ${tenant}::uuid
        `),
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.prev_hash, null);
      assert.equal(rows[0]?.event_hash, null);
      assert.deepEqual(await verifyTenantHashChain(tx, tenant), { ok: true, chained: false, events: 1 });
    });
  });

  it("uses one pepper per tenant for nik_hash and reveals only with permission", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const actor = randomUUID();
    const resourceId = randomUUID();
    let hashA = "";
    let envelope = "";
    await app.withTenantContext(tenantA, async (tx) => {
      await provisionTenantKeys(tx, tenantA, TEST_KEK);
      const secrets = await readTenantSecrets(tx, tenantA, TEST_KEK);
      hashA = blindIndex(secrets.pepper, nik);
      assert.equal(blindIndex(secrets.pepper, nik), hashA);
      envelope = encryptField(secrets.dek, tenantA, "nik", nik);
      assert.notEqual(envelope, nik);
      await assert.rejects(
        () =>
          revealPii(
            tx,
            { tenantId: tenantA, userId: actor, permissions: ["employee.pii.read"] },
            {
              field: "nik",
              ciphertext: asCiphertext(envelope),
              resourceType: "hr_employee_pii",
              resourceId,
              reason: "payroll check",
            },
            TEST_KEK,
          ),
        (error: unknown) => error instanceof PiiRevealDeniedError && error.statusCode === 403,
      );
      await assert.rejects(
        () =>
          revealPii(
            tx,
            { tenantId: tenantA, userId: actor, permissions: [] },
            {
              field: "nik",
              ciphertext: asCiphertext(envelope),
              resourceType: "hr_employee_pii",
              resourceId,
              reason: "   ",
            },
            TEST_KEK,
          ),
        (error: unknown) => error instanceof PiiRevealDeniedError && error.statusCode === 403,
      );
      await assert.rejects(
        () =>
          revealPii(
            tx,
            { tenantId: tenantA, userId: actor, permissions: ["employee.pii.reveal"] },
            {
              field: "nik",
              ciphertext: asCiphertext(envelope),
              resourceType: "hr_employee_pii",
              resourceId,
              reason: "   ",
            },
            TEST_KEK,
          ),
        (error: unknown) => error instanceof PiiRevealReasonError && error.statusCode === 400,
      );
      assert.equal(await countOf(tx, "aud_pii_access_logs"), 0);
      const revealed = await revealPii(
        tx,
        { tenantId: tenantA, userId: actor, permissions: ["employee.pii.reveal"], ipAddress: "203.0.113.8" },
        {
          field: "nik",
          ciphertext: asCiphertext(envelope),
          resourceType: "hr_employee_pii",
          resourceId,
          reason: "payroll correction",
        },
        TEST_KEK,
      );
      assert.equal(revealed, nik);
      assert.equal(await countOf(tx, "aud_pii_access_logs"), 1);
    });

    await app.withTenantContext(tenantB, async (tx) => {
      await provisionTenantKeys(tx, tenantB, TEST_KEK);
      const secrets = await readTenantSecrets(tx, tenantB, TEST_KEK);
      const hashB = blindIndex(secrets.pepper, nik);
      assert.notEqual(hashB, hashA);
      assert.equal(await countOf(tx, "aud_pii_access_logs"), 0);
      assert.equal(await countOf(tx, "aud_tenant_keys"), 1);
    });
  });

  it("rolls back an outbox row with the domain write and publishes a committed row", async () => {
    const rolled = randomUUID();
    await assert.rejects(
      app.withTenantContext(rolled, async (tx) => {
        await tx.execute(sql`INSERT INTO rls_probe (tenant_id) VALUES (${rolled}::uuid)`);
        await enqueueOutboxEvent(tx, {
          tenantId: rolled,
          topic: "audit.test.ping",
          payload: { n: 1, nik },
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    const gone = await superuser.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM aud_outbox_events WHERE tenant_id = $1",
      [rolled],
    );
    const probes = await superuser.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM rls_probe WHERE tenant_id = $1",
      [rolled],
    );
    assert.equal(gone.rows[0]?.n, 0);
    assert.equal(probes.rows[0]?.n, 0);

    const tenant = randomUUID();
    const queued = await app.withTenantContext(tenant, async (tx) => {
      await tx.execute(sql`INSERT INTO rls_probe (tenant_id) VALUES (${tenant}::uuid)`);
      return enqueueOutboxEvent(tx, {
        tenantId: tenant,
        topic: "audit.test.ping",
        payload: { n: 2, nik },
      });
    });
    const stored = await superuser.query<{ payload: { nik?: string }; published_at: Date | null }>(
      "SELECT payload, published_at FROM aud_outbox_events WHERE id = $1",
      [queued.id],
    );
    assert.equal(stored.rows[0]?.payload.nik, "[redacted]");
    assert.equal(stored.rows[0]?.published_at, null);

    const queueUrl = requiredEnv(process.env, "DATABASE_URL_QUEUE");
    const boss = new PgBoss({
      connectionString: queueUrl,
      schema: QUEUE_SCHEMA,
      createSchema: false,
      migrate: false,
    });
    await boss.start();
    try {
      const first = await dispatchOutboxOnce(boss, queueUrl);
      assert.equal(first.failed, 0);
      assert.equal(first.published, 1);
      const published = await superuser.query<{ published_at: Date | null; attempts: number }>(
        "SELECT published_at, attempts FROM aud_outbox_events WHERE id = $1",
        [queued.id],
      );
      assert.ok(published.rows[0]?.published_at);
      assert.equal(published.rows[0]?.attempts, 1);
      const jobs = await superuser.query<{ n: number; topic: string | null }>(
        `SELECT count(*)::int AS n, min(data->>'topic') AS topic
         FROM pgboss.job
         WHERE name = $1 AND data->>'outboxId' = $2`,
        [OUTBOX_QUEUE, queued.id],
      );
      assert.equal(jobs.rows[0]?.n, 1);
      assert.equal(jobs.rows[0]?.topic, "audit.test.ping");
      const again = await dispatchOutboxOnce(boss, queueUrl);
      assert.equal(again.published, 0);
      const jobsAfter = await superuser.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'outboxId' = $2`,
        [OUTBOX_QUEUE, queued.id],
      );
      assert.equal(jobsAfter.rows[0]?.n, 1);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  });
});
