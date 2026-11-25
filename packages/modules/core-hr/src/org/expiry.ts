import { enqueueOutboxEvent } from "@gotonghr/audit";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { queryRows } from "../sql.ts";
import { addIsoDays, contractExpiryDedupeKey, isExpiryWindow, jakartaDate } from "./dates.ts";

const { Client } = pg;

export const CONTRACT_EXPIRING_TOPIC = "core_hr.contract_expiring";

interface DueContract {
  contractId: string;
  tenantId: string;
  employeeId: string;
  contractType: string;
  endDate: string;
  windowDays: number;
}

/**
 * Inserts `core_hr.contract_expiring` outbox rows for active contracts that end
 * in 90, 60, or 30 days. It does not send email.
 * The notice row's dedupe key makes a second run on the same Jakarta day a no-op.
 */
export async function scanContractExpiry(input: {
  appDb: TenantDatabase;
  queueUrl: string;
  now: Date;
}): Promise<{ noticeOn: string; scanned: number; emitted: number }> {
  const noticeOn = jakartaDate(input.now);
  const due = await listDueContracts(input.queueUrl, noticeOn);
  let emitted = 0;
  for (const row of due) {
    const wrote = await input.appDb.withTenantContext(row.tenantId, (tx) => emitNotice(tx, row, noticeOn));
    if (wrote) emitted += 1;
  }
  return { noticeOn, scanned: due.length, emitted };
}

async function listDueContracts(queueUrl: string, noticeOn: string): Promise<DueContract[]> {
  const client = new Client({ connectionString: queueUrl });
  await client.connect();
  try {
    const result = await client.query<{
      id: string;
      tenant_id: string;
      employee_id: string;
      contract_type: string;
      end_date: string;
      window_days: number | null;
    }>(
      `SELECT id::text AS id,
              tenant_id::text AS tenant_id,
              employee_id::text AS employee_id,
              contract_type,
              end_date::text AS end_date,
              CASE end_date
                WHEN $1::date THEN 30
                WHEN $2::date THEN 60
                WHEN $3::date THEN 90
              END::int AS window_days
       FROM hr_contracts
       WHERE status = 'active'
         AND end_date IN ($1::date, $2::date, $3::date)`,
      [addIsoDays(noticeOn, 30), addIsoDays(noticeOn, 60), addIsoDays(noticeOn, 90)],
    );
    const due: DueContract[] = [];
    for (const row of result.rows) {
      const windowDays = Number(row.window_days);
      if (!isExpiryWindow(windowDays)) continue;
      due.push({
        contractId: row.id,
        tenantId: row.tenant_id,
        employeeId: row.employee_id,
        contractType: row.contract_type,
        endDate: row.end_date,
        windowDays,
      });
    }
    return due;
  } finally {
    await client.end();
  }
}

async function emitNotice(tx: TenantTx, due: DueContract, noticeOn: string): Promise<boolean> {
  const dedupeKey = contractExpiryDedupeKey(due.contractId, due.windowDays, noticeOn);
  const inserted = queryRows<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO hr_contract_expiry_notices (
        tenant_id, contract_id, window_days, notice_on, dedupe_key
      ) VALUES (
        ${due.tenantId}::uuid,
        ${due.contractId}::uuid,
        ${due.windowDays},
        ${noticeOn}::date,
        ${dedupeKey}
      )
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
      RETURNING id::text AS id
    `),
  );
  if (!inserted[0]) return false;
  await enqueueOutboxEvent(tx, {
    tenantId: due.tenantId,
    topic: CONTRACT_EXPIRING_TOPIC,
    payload: {
      contractId: due.contractId,
      employeeId: due.employeeId,
      contractType: due.contractType,
      windowDays: due.windowDays,
      endDate: due.endDate,
      noticeOn,
      dedupeKey,
    },
  });
  return true;
}
