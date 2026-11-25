# GotongHR

GotongHR is an Indonesian HRIS for a 1–2 GB VPS. Product scope, module boundaries, and the API are defined in the GotongHR architecture and MVP specification. This file does not restate that document.

## Install

Node 22.12 or newer is required.

```bash
corepack enable
corepack pnpm install
cp .env.example .env
```

## Boot

```bash
docker compose -f docker/docker-compose.vps.yml up -d --build
```

The shell is served at `http://localhost/`. Readiness is `http://localhost/api/readyz`.

The 1 GB profile tightens the same stack:

```bash
docker compose -f docker/docker-compose.vps.yml -f docker/docker-compose.vps.1g.yml up -d --build
```

`pnpm test` uses the published Postgres port. Start Postgres before the test:

```bash
docker compose -f docker/docker-compose.vps.yml up -d postgres
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Memory budget

| Component | 1 GB RAM VPS (Minimum) | 2 GB RAM VPS (Recommended) | Hard Engineering Enforcements |
| :--- | :--- | :--- | :--- |
| Linux OS + Docker Engine | ~180 MB | ~220 MB | Minimal Ubuntu/Debian, journald capped at 50 MB, 1 GB zram/swapfile safety net. |
| Caddy 2 (TLS + Static SPA) | 30 MB (limit 64 MB) | 35 MB (limit 64 MB) | Serves pre-compressed `.br`/`.gz` Vite assets directly from disk; zero Node SSR process. |
| PostgreSQL 18 (`postgres:18-alpine`) | 260 MB (limit 384 MB) | 512 MB (limit 768 MB) | Tuned `shared_buffers`, `work_mem`, `max_connections=40`, PG 18 AIO (`io_method=worker`/`io_uring`); hosts app + `pg-boss` (no Redis, saves 150+ MB). |
| Fastify Monolith + `pg-boss` | 220 MB (limit 384 MB) | 350 MB (limit 640 MB) | `NODE_OPTIONS="--max-old-space-size=320"` (1 GB) or `512` (2 GB); worker concurrency capped at `2`; pure-JS `pdfkit` payslips (no Chromium, saves 500+ MB); direct-to-S3/disk streaming uploads. |
| Headroom / Page Cache | ~334 MB | ~931 MB | Absorbs 08:00 WIB bursts and month-end payroll PDF/XML generation without OOM kills. |
| Total Active Footprint | ~690 MB / 1,024 MB | ~1,117 MB / 2,048 MB | Zero OOM risk; <150ms p95 API latency on 1 vCPU. |
