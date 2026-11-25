# GotongHR

GotongHR is an Indonesian HRIS for a 1–2 GB VPS. Product scope, module boundaries, and the API are defined in the GotongHR architecture and MVP specification. This file does not restate that document.

## Install

Node 22.13 or newer is required. ESLint 10 does not run on Node 22.12. Stay on the Node 22 line. Node 25 does not ship Corepack, so `corepack enable` fails there until Corepack is installed separately.

```bash
corepack enable
corepack pnpm install
cp .env.example .env
```

Replace `STORAGE_LOCAL_SECRET` in `.env` with at least 32 random characters before tests or a local boot. The value in `.env.example` is a placeholder. The database passwords in `.env.example` are local placeholders. `NODE_ENV=production` refuses those placeholders, including a placeholder password already embedded in a `DATABASE_URL_*` value. Compose does not invent them.

## Boot

```bash
docker compose --env-file .env -f docker/docker-compose.vps.yml up -d --build
```

The shell is served at `http://localhost/`. Readiness is `http://localhost/api/readyz`. Compose reads variables from the repo-root `.env` only when `--env-file .env` is set, because the compose file lives in `docker/`. A one-shot `migrate` service applies roles and the queue schema, then exits. The API process does not connect as the database superuser.

## Bootstrap

`GOTONG_DEPLOYMENT_MODE=single_tenant` is the default. After migrate, create the one tenant and its `org_owner`:

```bash
pnpm --filter @gotonghr/api bootstrap
```

Set `GOTONG_BOOTSTRAP_EMAIL` and `GOTONG_BOOTSTRAP_PASSWORD` (12 to 128 characters). Run one bootstrap at a time. The command takes a Postgres advisory lock, so an overlapping run waits and then sees the existing tenant instead of creating a second one. The same email returns the existing tenant. A different email is refused. `NODE_ENV=production` refuses the placeholder auth secret, the placeholder bootstrap password, and a `BETTER_AUTH_URL` that is missing or not `https://`.

`BETTER_AUTH_URL` is the browser origin, such as `http://localhost` behind Caddy. It is not the API bind address. Extra browser origins go in `GOTONG_TRUSTED_ORIGINS` as a comma-separated list. Sign-in is mounted at `/api/auth/*`. `/api/v1/platform/*` is mounted only when `GOTONG_DEPLOYMENT_MODE` is `multi_tenant_saas` or `holding_multi_tenant`, and those handlers use `DATABASE_URL_PLATFORM`. `single_tenant` does not mount them. Session cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`, so a browser stores them only after TLS terminates in front of the API.

Sign-in, password reset, and the two-factor verification routes are limited separately, per IP. The defaults are 10 requests per 60 seconds. Override them with `GOTONG_AUTH_RATE_LIMIT_MAX` and `GOTONG_AUTH_RATE_LIMIT_WINDOW_MS`. `GOTONG_TRUST_PROXY` defaults to `1`: one forwarding hop, and only when the socket peer is loopback, link-local, or a private address. That assumes port 3000 is reachable only from Caddy or the Docker network. Set an address or CIDR list when it is not. `true` is rejected. `CF-Connecting-IP` is used only when `GOTONG_TRUST_CLOUDFLARE=true` and the socket peer is a trusted proxy, which requires Cloudflare Tunnel or Authenticated Origin Pulls.

Postgres is published on `127.0.0.1:5432` and the API on `127.0.0.1:3000`. Caddy publishes port 80. TLS is not configured in this slice: the Phase 0 checks use HTTP until a hostname exists.

The 1 GB profile tightens the same stack:

```bash
docker compose --env-file .env -f docker/docker-compose.vps.yml -f docker/docker-compose.vps.1g.yml up -d --build
```

`pnpm test` uses the published Postgres port. Start Postgres before the test:

```bash
docker compose --env-file .env -f docker/docker-compose.vps.yml up -d postgres
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Web UI

The shell is Vite, React, and Tailwind. `@reui` in `apps/web/components.json` is the registry the component CLI reads when a component is added. Added components are copied into this repo, and that diff is what gets reviewed. The running app does not fetch the registry.

`VITE_DEPLOYMENT_MODE` includes the platform route only for `multi_tenant_saas` and `holding_multi_tenant`. Any other value, including `single_tenant`, omits it. `apps/web/scripts/bundle-budget.mjs` reads the Vite env files under `apps/web` (`.env`, `.env.local`, `.env.production`, `.env.production.local`) and lets `VITE_DEPLOYMENT_MODE` in the process environment override them. A build that is not one of the two multi-tenant modes fails if the platform chunk or the `data-gotong-platform-console` marker is present. A multi-tenant build fails if that marker is missing.

## Memory budget

The numbers below are the design budget from the architecture spec. This slice enforces the container memory caps in Compose. It does not measure API latency, and it does not claim the process cannot run out of memory.

| Component | 1 GB RAM VPS (Minimum) | 2 GB RAM VPS (Recommended) | What this slice enforces |
| :--- | :--- | :--- | :--- |
| Linux OS + Docker Engine | ~180 MB | ~220 MB | Budget for the host. Not installed by this repo. |
| Caddy 2 | 30 MB (limit 64 MB) | 35 MB (limit 64 MB) | Serves pre-compressed `.br`/`.gz` Vite assets from disk. No Node SSR. HTTP until a hostname is set. |
| PostgreSQL 18 (`postgres:18-alpine`) | 260 MB (limit 384 MB) | 512 MB (limit 768 MB) | `shared_buffers`, `work_mem`, `max_connections=40`, and `io_method=worker`. `io_uring` is not enabled. Hosts the app and `pg-boss`. |
| Fastify monolith + `pg-boss` | 220 MB (limit 384 MB) | 350 MB (limit 640 MB) | Heap cap 320 MB on the 1 GB profile and 512 MB on the 2 GB profile. Worker concurrency is 2. Local uploads are buffered up to 2 MB, written to a temporary file, and renamed into place. |
| Headroom / page cache | ~334 MB | ~931 MB | Room left in the design budget. |
| Total active footprint | ~690 MB / 1,024 MB | ~1,117 MB / 2,048 MB | Sum of the design budget. |

Payslip PDFs are rendered by `packages/payslip-pdf` without Chromium. That package's test checks one PDF stays under 20 MB RSS above a warmed baseline. This table is the container budget, not that measurement.

## Object storage

A local token can cap an upload below 2 MB. A request within the 2 MB body limit that exceeds the token cap returns `too_large` and names that cap. A request larger than 2 MB is rejected by the body limit before that check. S3 uploads use a presigned POST whose policy includes `content-length-range`. Set both `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, or set neither.
