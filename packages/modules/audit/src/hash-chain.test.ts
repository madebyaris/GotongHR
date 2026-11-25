import assert from "node:assert/strict";
import test from "node:test";
import {
  eventHash,
  genesisHash,
  hashChainEnabledFromEnv,
  verifyChain,
  type StoredAuditEvent,
} from "./hash-chain.ts";

const tenantId = "11111111-1111-7111-8111-111111111111";

function event(overrides: Partial<StoredAuditEvent> & Pick<StoredAuditEvent, "id" | "createdAt" | "diff">): StoredAuditEvent {
  const prevHash = overrides.prevHash === undefined ? genesisHash(tenantId) : overrides.prevHash;
  const fields = {
    id: overrides.id,
    tenantId,
    actorUserId: overrides.actorUserId ?? null,
    actorRole: overrides.actorRole ?? "hr_admin",
    action: overrides.action ?? "update",
    resourceType: overrides.resourceType ?? "hr_employee",
    resourceId: overrides.resourceId ?? "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
    diff: overrides.diff,
    aiProposalId: overrides.aiProposalId ?? null,
    supportGrantId: overrides.supportGrantId ?? null,
    ipAddress: overrides.ipAddress ?? null,
    userAgent: overrides.userAgent ?? null,
    createdAt: overrides.createdAt,
    prevHash: prevHash ?? genesisHash(tenantId),
  };
  return {
    ...fields,
    prevHash,
    eventHash: overrides.eventHash === undefined ? eventHash(fields) : overrides.eventHash,
  };
}

test("AUDIT_HASH_CHAIN defaults to on", () => {
  assert.equal(hashChainEnabledFromEnv({}), true);
  assert.equal(hashChainEnabledFromEnv({ AUDIT_HASH_CHAIN: "on" }), true);
  assert.equal(hashChainEnabledFromEnv({ AUDIT_HASH_CHAIN: "off" }), false);
  assert.throws(() => hashChainEnabledFromEnv({ AUDIT_HASH_CHAIN: "maybe" }), /on or off/);
});

test("the hash chain links two events and rejects a tampered diff", () => {
  const first = event({
    id: "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
    createdAt: "2026-11-25T01:00:00.000Z",
    diff: { before: { label: "a", nik: "[redacted]" }, after: { label: "b", nik: "[redacted]" } },
  });
  const second = event({
    id: "cccccccc-cccc-7ccc-8ccc-cccccccccccc",
    createdAt: "2026-11-25T01:00:01.000Z",
    prevHash: first.eventHash,
    diff: { before: { label: "b" }, after: { label: "c" } },
  });
  assert.equal(first.eventHash?.length, 64);
  assert.equal(second.prevHash, first.eventHash);
  assert.deepEqual(verifyChain(tenantId, [first, second]), { ok: true, chained: true, events: 2 });

  const tampered: StoredAuditEvent = {
    ...first,
    diff: { before: { label: "tampered" }, after: { label: "b" } },
  };
  const result = verifyChain(tenantId, [tampered, second]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.eventId, first.id);
});

test("key order does not change the event hash", () => {
  const left = eventHash({
    id: "dddddddd-dddd-7ddd-8ddd-dddddddddddd",
    tenantId,
    actorUserId: null,
    actorRole: null,
    action: "update",
    resourceType: "hr_employee",
    resourceId: null,
    diff: { before: { b: 1, a: 2 }, after: { a: 3 } },
    aiProposalId: null,
    supportGrantId: null,
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-11-25T01:00:00.000Z",
    prevHash: genesisHash(tenantId),
  });
  const right = eventHash({
    id: "dddddddd-dddd-7ddd-8ddd-dddddddddddd",
    tenantId,
    actorUserId: null,
    actorRole: null,
    action: "update",
    resourceType: "hr_employee",
    resourceId: null,
    diff: { after: { a: 3 }, before: { a: 2, b: 1 } },
    aiProposalId: null,
    supportGrantId: null,
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-11-25T01:00:00.000Z",
    prevHash: genesisHash(tenantId),
  });
  assert.equal(left, right);
});

test("a chain with null hashes is not a broken chain", () => {
  const row = event({
    id: "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee",
    createdAt: "2026-11-25T01:00:00.000Z",
    diff: { before: null, after: { label: "a" } },
    prevHash: null,
    eventHash: null,
  });
  assert.deepEqual(verifyChain(tenantId, [row]), { ok: true, chained: false, events: 1 });
});
