# GotongHR agent notes

Read this file before editing. Product scope lives in the GotongHR architecture and MVP specification. Do not restate it here.

## Model map

```text
# defaults: 3
# budget: large (xhigh)
feature, refactoring: grok-4.7-xhigh
bug-fix: grok-4.7-xhigh
perf-issue: grok-4.7-xhigh
hillclimb: grok-4.7-xhigh
judgment and prose: grok-4.7-xhigh
swarm workers: grok-4.7-xhigh
arena runners: grok-4.7-xhigh, claude-opus-5-5-high, gemini-4-neon-xhigh
interrogate reviewers: grok-4.7-xhigh, claude-opus-5-5-high, gemini-4-neon-xhigh
arena cross-judge pool: claude-opus-5-5-high, gemini-4-neon-xhigh
```

The judge pool omits Grok because the parent worker is Grok. This map stays in the repository. Do not write it into the home directory.

## Shared check

Run this before a pull request. Do not replace it with a narrower command.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Also run:

```bash
pnpm exec depcruise --config tooling/arch-tests/.dependency-cruiser.cjs packages apps
```

`pnpm test` needs Postgres 18 from `docker compose --env-file .env -f docker/docker-compose.vps.yml up -d postgres` and a `.env` copied from `.env.example`.

## Slice checks

Use the command named for the slice. Do not invent a replacement.

| Slice | Command |
| :--- | :--- |
| 0.1 | `pnpm install`, `pnpm typecheck`, `pnpm lint`, and the depcruise command above |
| 0.2 | `pnpm --filter @gotonghr/db test` |
| 0.3 | `pnpm --filter @gotonghr/api test` and `docker compose --env-file .env -f docker/docker-compose.vps.yml up -d postgres api` |
| 0.4 | `pnpm --filter @gotonghr/web build`, `node apps/web/scripts/bundle-budget.mjs`, and `docker compose --env-file .env -f docker/docker-compose.vps.yml -f docker/docker-compose.vps.1g.yml up -d` |
| 4.4 | `pnpm --filter @gotonghr/payslip-pdf test` |
| Every later slice | The shared check, depcruise, and the slice command in the implementation plan |

## Stack

Node 22.13 or newer, pnpm, Turborepo, Vite, Fastify, PostgreSQL 18. Do not add Next.js, Redis, Prisma, or a headless browser. Money is integer rupiah in `bigint`. `packages/payroll-engine` does no database, network, or LLM work. `packages/payslip-pdf` does no database, network, storage, or Chromium work. Modules talk through ports in `packages/contracts`. Request-time database roles do not have `BYPASSRLS`.
