---
name: verify-gotonghr-invariants
description: >
  Check GotongHR invariants after a change to tenant context, platform grants,
  packages/payroll-engine/src/pph21, payroll run status, or ai_action_proposals.
---

# Verify GotongHR invariants

Four properties. This tree has the `hitl` model. `rls`, `pph21`, and `payroll_run` are not in this tree yet. Do not invent their models here.

The TLA+ model is the proposal transitions, not the whole HRIS. Read `/statechart` for a TLA+ check. Do not copy its command flags into this skill.

## When to run

- Tenant context or platform grants: `rls`. Not added yet.
- `packages/payroll-engine/src/pph21`: `pph21`. Not added yet. The code check, once that slice lands, is `pnpm --filter @gotonghr/payroll-engine test:invariants`. It draws inputs on the real functions. It does not certify a missing TER table.
- Payroll run status: `payroll_run`. Not added yet.
- `ai_action_proposals`: `hitl`.

## Properties

1. **RLS.** A session for tenant A never returns or writes a row whose tenant is B, even when the statement has no tenant predicate. A `platform_admin` session never reads employee PII, payslips, or attendance rows unless a grant for that tenant is unexpired, unrevoked, and unused. Harm: one company sees another's people, or an operator reads PII without the tenant's approval.
2. **PPh 21.** For a fixed rate table, the monthly TER tax and the December Pasal 17 settlement are pure functions of the documented inputs. December settlement equals Pasal 17 tax on the rounded PKP minus tax already withheld. Gross-up allowance equals the tax on the grossed base within Rp1. PKP is rounded down to Rp1,000. Harm: a payslip shows the wrong tax and the Coretax file disagrees with DJP.
3. **Payroll run.** Status moves only from `draft` to `calculated` to `approved` to `finalized`. A finalized item's money fields do not change. A second finalize does not enqueue a second PDF batch. Harm: numbers already sent to a bank or to DJP change quietly.
4. **HITL.** A mutating tool writes a `pending` proposal and does not change domain tables. Confirm with the matching nonce, the same user, and a live expiry runs the action once and sets `executed`. Any other confirm leaves the domain tables unchanged. Harm: the model approves payroll or edits an employee by itself.

## hitl

Model: `tooling/formal/hitl/Hitl.tla`.

Config: `tooling/formal/hitl/Hitl.cfg`.

View: `tooling/formal/hitl/Hitl.view.js`.

`Propose` writes `pending` and does not change `domain`. `Confirm` from `pending` increments `domain` once and sets `executed`. `Reject`, `Expire`, and `WrongConfirm` leave `domain` at 0. `SecondConfirm` does not run again.

Do not weaken `PendingLeavesDomain`, `ExecutedOnce`, `ClosedLeavesDomain`, or `RunsMatchDomain` to make a failure go away.

SQL policies added after this model are out of scope until the model and the isolation suite list them.

Last human confirmation of `hitl`: not yet. The next person moves that line only after reading the diff of `ai_action_proposals` and this model.
