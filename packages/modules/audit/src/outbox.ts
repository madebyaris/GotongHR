import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { redactPii } from "./redact.ts";
import { queryRows } from "./sql.ts";
import { assertSameTenant } from "./tenant.ts";

const TOPIC = /^[a-z0-9]+(?:[._][a-z0-9]+)*$/u;
const MAX_PAYLOAD_CHARS = 65_536;

export interface OutboxInput {
  tenantId: string;
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * Inserts one outbox row on the caller's transaction.
 * A rollback of that transaction removes the row.
 */
export async function enqueueOutboxEvent(
  tx: TenantTx,
  input: OutboxInput,
): Promise<{ id: string }> {
  const tenantId = await assertSameTenant(tx, input.tenantId);
  if (!TOPIC.test(input.topic) || input.topic.length > 80) {
    throw new Error("outbox topic is invalid");
  }
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("outbox payload must be an object");
  }
  const encoded = JSON.stringify(redactPii(input.payload));
  if (encoded.length > MAX_PAYLOAD_CHARS) throw new Error("outbox payload is too large");
  const rows = queryRows<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO aud_outbox_events (tenant_id, topic, payload)
      VALUES (${tenantId}::uuid, ${input.topic}, ${encoded}::jsonb)
      RETURNING id::text AS id
    `),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("outbox insert failed");
  return { id };
}
