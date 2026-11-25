# GotongHR verification map

This directory is the source for the owner setup and employee screens. Read this index, then use one feature file as the recipe.

## Baseline preconditions

- Launch with `.cursor/skills/verify-gotonghr/scripts/verify.sh launch`.
- The project name is `gotonghr-verify-$RUN_ID`. The database volume is new.
- Doctor must print `doctor=ok` before a drive.
- The browser origin is `BASE_URL` in `/tmp/gotonghr-verify/$RUN_ID/stack.env`.
- The owner email is `owner@gotonghr.local`. The password is in that run's `verify.env`.
- Never drive a compose project this run did not start.

## Driving conventions

- Start from the signed-out SPA unless the feature says the owner is already signed in.
- Prefer ARIA roles and accessible names.
- Treat the locators in each feature file as the recipe.
- `verify.sh drive` runs feature 03. The other features use the same Playwright session shape.
- Do not delete `/tmp/gotonghr-verify/$RUN_ID/evidence` during cleanup.

## Proof and skip reporting

- Capture the action and the state after reload, not only the first success line.
- UI proof is an ARIA snapshot and a screenshot that shows `GotongHR`.
- HTTP proof is the response status and the JSON body.
- A mutation also needs a SQL read of the stored row.
- Record the feature id in the evidence file name.
- An unreachable path is a failure. Name the command and the missing precondition.
- Do not mark a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph. Then it has these H2 sections, in order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with Playwright`
4. `Gotchas`

## Features

- [Sign in as the bootstrapped owner](./01-owner-sign-in.md)
- [Create a legal entity and a branch](./02-legal-entity-and-branch.md)
- [Create an employee and see the masked NIK after reload](./03-employee-create-masked-nik.md)
- [Reveal PII and see an audit row from a second read](./04-pii-reveal-audit-row.md)

`/ess` and `/admin/assistant` are outside this map.
