---
name: verify-gotonghr-invariants
description: >
  Check GotongHR invariants after a change to tenant context, platform grants,
  packages/payroll-engine/src/pph21, payroll run status, or ai_action_proposals.
---

# Verify GotongHR invariants

Four properties. Run the check that matches the change.

Read `/statechart` before a TLA+ check. Do not copy its command flags into this skill. Those flags change between machines.

## Properties

1. **RLS.** A session for tenant A never returns or writes a row whose tenant is B, even when the statement has no tenant predicate. A `platform_admin` session never reads employee PII, payslips, or attendance rows unless a grant for that tenant is unexpired, unrevoked, and unused. Harm: one company sees another's people, or an operator reads PII without the tenant's approval.
2. **PPh 21.** For a fixed rate table, the monthly TER tax and the December Pasal 17 settlement are pure functions of the documented inputs. December settlement equals Pasal 17 tax on the rounded PKP minus tax already withheld. Gross-up allowance equals the tax on the grossed base within Rp1. PKP is rounded down to Rp1,000. Harm: a payslip shows the wrong tax and the Coretax file disagrees with DJP.
3. **Payroll run.** Status moves only from `draft` to `calculated` to `approved` to `finalized`. A finalized item's money fields do not change. A second finalize does not enqueue a second PDF batch. Harm: numbers already sent to a bank or to DJP change quietly.
4. **HITL.** A mutating tool writes a `pending` proposal and does not change domain tables. Confirm with the matching nonce, the same user, and a live expiry runs the action once and sets `executed`. Any other confirm leaves the domain tables unchanged. Harm: the model approves payroll or edits an employee by itself.

## Scope

The TLA+ models cover the transitions and the pool. They do not cover the whole HRIS.

The PPh 21 check covers the inputs fast-check draws inside its bounds, and the verified golden cases when that file has them. It does not certify a missing TER table.

A SQL policy added after the recorded sync commit is out of scope until the model and the isolation suite list it.

Each check records the commit where the model or the test last matched the code. Read the diff from that commit before you replace it. Do not advance the commit only because `main` moved.

## When to run

- Tenant context or platform grants: `rls`.
- `packages/payroll-engine/src/pph21`: `pph21`.
- Payroll run status: `payroll_run`. Not in this tree yet.
- `ai_action_proposals`: `hitl`.

## rls

Model: `tooling/formal/rls/Rls.tla`.

Config: `tooling/formal/rls/Rls.cfg`.

View: `tooling/formal/rls/Rls.view.js`.

Read `/statechart` and check that model. Then run:

```bash
pnpm --filter @gotonghr/db test:isolation
```

The model has two pooled connections. `withTenantContext` is `set_config('app.current_tenant_id', ..., true)`. Reads and writes have no `tenant_id` predicate. `platform_admin` has no `BYPASSRLS`. One support grant can expire, be revoked, or be activated once. In this model, unused means the token has not already been spent. Activation consumes it and opens the one session that may read. A second activation does not. `allow_pii_reveal` false does not return raw PII.

`ScopedTenant` is the `set_config` result. `ReleasedGuc` is the value left on the pooled session at commit. Do not weaken these invariants: `NoCrossTenantRead`, `NoCrossTenantWrite`, `PoolDoesNotLeakTenant`, `TenantTxSetsLocalGuc`, `PlatformNeedsLiveGrant`, `PiiRevealNeedsAllow`, `PlatformAdminNoBypass`, `GrantActivatesOnce`.

Sync commit: `d84ebf0f3a5c4c8127fe8b031bac0a8f4ddd8f85`.

That commit is `main` when this model was read against `packages/db/src/client.ts`, `packages/db/src/policy.ts`, `packages/db/src/migrate.ts`, `packages/db/src/isolation.integration.test.ts`, `packages/modules/platform/src/grants.ts`, and `packages/modules/audit/src/reveal.ts`.

### Verification note

The scratch edits were restored. Product code is unchanged.

TLC with `set_config` omitted (`ScopedTenant(c, t) == sessionGuc[c]`) exited 12. `TenantTxSetsLocalGuc` failed. State 2 is `BeginTenant`. `caller` for `c1` is `A`, `phase` for `c1` is `tx`, and `localGuc` for `c1` is `none`. TLC had generated 2 states.

TLC with the pool reset omitted (`ReleasedGuc(c) == localGuc[c]`) exited 12. `PoolDoesNotLeakTenant` failed. State 3 is `Commit`. `phase` for `c1` is `idle`, and both `sessionGuc` and `localGuc` for `c1` are `A`.

Both operators were restored (`t` and `None`). TLC then reported no error: 3261 states generated, 285 distinct states, search depth 6.

Commenting out only the `set_config` call made `tsc` fail with TS6133, because `sql` was unused, so the suite did not start. The scratch that reached the suite commented out that call and kept `void sql` so the build still ran. `pnpm --filter @gotonghr/db test:isolation` exited 1. The run had 7 tests, 4 passed, 2 failed, and 1 was cancelled.

`isolation.integration.test.ts:176` threw `AssertionError` on `SELECT id::text AS id, tenant_id::text AS tenant_id FROM ai_action_proposals`. Actual was `false` and expected was `true`, so the caller's own row was not returned. `isolation.integration.test.ts:356` threw the same mismatch on `UPDATE ai_action_proposals SET tenant_id = tenant_id RETURNING id::text AS id`. The support-grant hook threw `Error: tenant context does not match` from `assertSameTenant`, and the PII-reveal test was cancelled. The pooled-connection test passed, because the setting was never written.

`packages/db/src/client.ts` was restored. The same command then exited 0: 7 tests, 7 passed, 0 failed.

## pph21

This check is the real TypeScript, not a TLA+ model. `/statechart` is the wrong tool here.

```bash
pnpm --filter @gotonghr/payroll-engine test:invariants
pnpm --filter @gotonghr/payroll-engine test:golden
```

`test:invariants` draws inputs with fast-check on the engine functions. `test:golden` reads `packages/payroll-engine/src/__tests__/golden/pph21.verified.json`. At the sync commit that file has no verified cases. An empty file does not certify a TER table.

Sync commit: `01af6863eef396dcfd5262a96c981428b5c14086`.

That commit last changed `packages/payroll-engine/src/pph21` and the invariant and golden tests. Read the diff from it before you replace it.

## payroll_run

Not implemented. Slice 4.5 has not landed, and `packages/modules/payroll` is not in this tree. Do not add a model that pretends the status machine exists.

When that slice lands, add a TLA+ model of the status machine and read `/statechart` for it. The property text above stays as written.

## hitl

Model: `tooling/formal/hitl/Hitl.tla`.

Config: `tooling/formal/hitl/Hitl.cfg`.

View: `tooling/formal/hitl/Hitl.view.js`.

Read `/statechart` and check that model. Then run:

```bash
pnpm --filter @gotonghr/ai test
```

`Propose` writes `pending` and does not change `domain`. `Confirm` from `pending` increments `domain` once and sets `executed`. `Reject`, `Expire`, and `WrongConfirm` leave `domain` at 0. `SecondConfirm` does not run again. `WrongConfirm` is a wrong nonce or a wrong user. `Expire` is the clock. Neither one changes `domain`.

Do not weaken `PendingLeavesDomain`, `ExecutedOnce`, `ClosedLeavesDomain`, or `RunsMatchDomain`.

Sync commit: `d84ebf0f3a5c4c8127fe8b031bac0a8f4ddd8f85`.

That commit added the model and `packages/modules/ai/src/service.ts`. The confirm path there matches this model: a pending proposal runs once, and a wrong user, a wrong nonce, or an expired row does not. Read the diff from this commit before you replace it. TLC on this model reported no error: 14 states generated, 5 distinct states, search depth 3.
