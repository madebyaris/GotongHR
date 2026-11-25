---
name: verify-gotonghr
description: >
  Drive the GotongHR admin SPA and Fastify API the way an owner does:
  sign in, save a company, add an employee, and read the masked NIK.
  Use it after a change to those screens, and after the stack boots.
---

# Verify GotongHR

The surface is the Vite admin SPA and the Fastify API under `/api`. The owner sets up the company and adds an employee. `/ess` and `/admin/assistant` are not in this map yet.

One run owns one compose project, `gotonghr-verify-$RUN_ID`, and one fresh database. Do not drive a compose project this run did not start. Do not point Playwright at port 80, 3000, or 5432 until doctor has checked the container label.

## Launch

From the repo root:

```bash
.cursor/skills/verify-gotonghr/scripts/verify.sh launch
```

The script writes `/tmp/gotonghr-verify/$RUN_ID/project` before it starts anything. It refuses the launch when port 80, 3000, or 5432 is held by another compose project or by any other listener.

When `docker info` works, launch runs:

```bash
docker compose \
  --project-name "gotonghr-verify-$RUN_ID" \
  --env-file "/tmp/gotonghr-verify/$RUN_ID/verify.env" \
  -f docker/docker-compose.vps.yml \
  -f .cursor/skills/verify-gotonghr/compose.http.yml \
  up -d --build --wait --wait-timeout 600
```

`verify.sh config` runs that same pair of files through `docker compose config` and exits non-zero when the render fails. Launch runs that check before `up`.

The API image sets `NODE_ENV=production`. Production refuses an `http` `BETTER_AUTH_URL`, and Caddy in this file publishes HTTP on port 80. `compose.http.yml` sets `NODE_ENV=development` on `api` and `migrate` for that HTTP origin. Do not use the override when TLS terminates in front of Caddy.

The script generates passwords that are not the placeholders in `.env.example`. `BETTER_AUTH_URL` is `http://127.0.0.1`. Bootstrap runs inside the API container:

```bash
docker compose exec -T api node dist/entrypoints/bootstrap.js
```

The owner email is `owner@gotonghr.local`. The password is `GOTONG_BOOTSTRAP_PASSWORD` in the run's `verify.env`. Print the run id. Do not print the env file.

Ready means all three of these, not only a container that is up:

1. `pg_isready` in this project's postgres container succeeds for database `gotonghr`.
2. `GET http://127.0.0.1/api/readyz` returns 200 and `"status":"ready"`. Caddy rewrites that path to Fastify `/readyz`. The container healthcheck on port 3000 is not this check.
3. `SELECT owner_email FROM id_single_tenant_owner();` returns `owner@gotonghr.local`.

If the Docker daemon is not available, the script says so and starts the process stand-in. That stand-in is not the compose stack. A proof that used it must list the steps below. Those steps stay unverified on a host that actually runs compose.

Stand-in steps a compose host does not take:

- Postgres 18 is `initdb` on a data directory under `/tmp/gotonghr-verify/$RUN_ID/pgdata`, not the `pgdata` volume.
- The API is `node apps/api/dist/entrypoints/monolith.js` on the host, not the production image.
- The SPA is `scripts/serve-spa.mjs`. It keeps the `/api` prefix and rewrites only `/api/readyz`, matching `docker/Caddyfile`. It is not the Caddy container.
- `docker/postgres.vps.conf` is included when the server accepts it. A failed start retries with `shared_buffers = 128MB`.

## Doctor

```bash
.cursor/skills/verify-gotonghr/scripts/verify.sh doctor "$RUN_ID"
```

Doctor reads `/tmp/gotonghr-verify/$RUN_ID/stack.env`. It exits 2 when the postgres or Caddy container label is not `gotonghr-verify-$RUN_ID`. On the process stand-in it exits 2 when the API or SPA pid was not started with `GOTONG_VERIFY_RUN_ID`.

A passing doctor prints `doctor=ok`, `readyz=200`, and the owner email. It saves the readiness body to `evidence/doctor-readyz.json` and the email to `evidence/doctor-owner.txt`.

Run doctor again after a failed drive, before the next drive.

## Drive

Prefer ARIA roles and accessible names. The names below are the labels and buttons in the admin SPA.

```bash
.cursor/skills/verify-gotonghr/scripts/verify.sh drive "$RUN_ID"
```

That command doctors the run, then drives feature 03 with Playwright. The browser origin is `BASE_URL` from `stack.env` (`http://127.0.0.1` when Caddy is on port 80). Chromium stores the `Secure` session cookie on `127.0.0.1`. Do not use a LAN address.

Sign-in is the form. Employee create is the form. `GET /api/v1/employees` is only the assertion for fields the table hides. Do not insert the employee with SQL.

The list JSON includes `joinDate`, `employmentStatus`, `ptkpStatus`, `taxMethod`, `pph21SubjectType`, `legalEntityId`, and `branchId`. The table shows the name, the code, and `nikMask`. It must not show the 16-digit NIK or `nik_enc`.

The SQL read uses `DATABASE_URL_SUPERUSER` for this run's published Postgres port. It checks `hr_employees` and `hr_employee_pii.nik_mask`. It records whether `nik_enc` contains the raw NIK. It does not copy `nik_enc` into the evidence file.

Features 01, 02, and 04 are in the map. Drive them with the same Playwright locators in their files. Feature 03 is the scripted proof.

## Evidence

Save proof under `/tmp/gotonghr-verify/$RUN_ID/evidence`. Cleanup does not delete that directory.

Feature 03 writes:

- `03-employee-reload.png`, a full-page screenshot after reload, with `GotongHR` and the masked NIK visible.
- `03-employee-reload.aria.txt`, the body ARIA snapshot.
- `03-employees.json`, the `GET /api/v1/employees` body.
- `03-employee-row.txt`, the SQL row count, name, mask, and `enc_contains_plain=false`.

Capture the save and the reload. A status line by itself is not the proof.

## Cleanup

```bash
.cursor/skills/verify-gotonghr/scripts/verify.sh cleanup "$RUN_ID"
```

Compose cleanup is `docker compose ... down -v` for `gotonghr-verify-$RUN_ID` only. It removes that project's containers and the database volume. It does not remove another project, and it does not delete the evidence directory.

The process stand-in stops the API and SPA pids only when their command line and `GOTONG_VERIFY_RUN_ID` match, then stops Postgres with `pg_ctl -D` on this run's data directory and deletes that directory.

After cleanup, the screenshot must still be a non-empty file:

```bash
test -s "/tmp/gotonghr-verify/$RUN_ID/evidence/03-employee-reload.png"
wc -c "/tmp/gotonghr-verify/$RUN_ID/evidence/03-employee-reload.png"
```

Run cleanup after a failed launch too, so a partial project does not keep the ports.

## Helpers

| Script | Invocation |
| :--- | :--- |
| `scripts/verify.sh` | `launch`, `doctor`, `drive`, `cleanup`, `config` |
| `scripts/drive-employee.mjs` | Called by `verify.sh drive`. It uses Playwright and `pg` from `apps/web`. |
| `scripts/serve-spa.mjs` | Process stand-in only. `verify.sh launch` starts it. |
| `compose.http.yml` | Compose override for the HTTP origin. |

`verify.sh config` needs the Docker CLI. It does not need a running daemon beyond what `docker compose config` itself requires.

## Maintain

When a later slice changes a mapped screen, update the feature file and drive it once. Use `/maintain-verification-skill` at the end of Phases 3, 4, 5, and 6. That pass edits this directory. A product bug found there is a report, not a quiet change to the screen.
