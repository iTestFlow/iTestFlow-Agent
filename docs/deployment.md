# iTestFlow — Private Hosted Deployment Guide

iTestFlow runs as a **privately hosted, multi-user workspace** app. Each company hosts
its own instance and shares the URL only with internal users. This guide covers the
runtime topology, configuration, and operations. For the migration design and phase
history see [multi-user-migration-plan.md](multi-user-migration-plan.md).

## Services

A deployment runs three processes:

| Service | Command | Purpose |
|---|---|---|
| **web** | `npm run build` then `npm run start` | Next.js app + API (Node runtime) |
| **worker** | `npm run worker` | Background jobs: scheduled Azure DevOps sync, indexing |
| **postgres** | managed or self-hosted | All application data + job queue |

The web app and worker are independent processes that share PostgreSQL. You may run
multiple web replicas and/or multiple workers — the job queue claims work with
`FOR UPDATE SKIP LOCKED`, so no job is processed twice.

## Required environment variables

Set these via the hosting platform's secrets or a secret manager — **not** in the UI
(the app needs them before it can start). See [.env.example](../.env.example).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `APP_ENCRYPTION_KEY` | yes | base64-encoded 32-byte key; encrypts stored PATs/LLM keys. Store **outside** the database. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `SESSION_SECRET` | recommended | reserved for cookie HMAC hardening |
| `APP_MODE` | yes (`hosted`) | `hosted` ignores env credentials; `single-user` honors them (legacy/dev) |
| `BOOTSTRAP_OWNER_EMAIL` | yes | initial owner identity, seeded at startup |
| `BOOTSTRAP_OWNER_AZURE_ORG` | yes | initial enabled Azure DevOps org/workspace |
| `WORKER_AUTO_SYNC` | optional | `true` makes the worker periodically enqueue due workspace syncs |
| `WORKER_AUTO_SYNC_MS` | optional | auto-sync interval (default 15 min) |
| `WORKER_POLL_MS` | optional | worker idle poll interval (default 2s) |
| `PROJECT_CONTEXT_TOP_K` | optional | RAG retrieval breadth (default 8) |

> **Key rotation:** encrypted secrets store a `key_version`. To rotate, add a new key
> behind a new version in `encryption.service.ts` and re-encrypt; the column already
> records which key version each secret used.

## First-run / bootstrap

1. Provision PostgreSQL and set `DATABASE_URL`.
2. Run migrations: `npm run db:migrate`.
3. Set `BOOTSTRAP_OWNER_EMAIL` + `BOOTSTRAP_OWNER_AZURE_ORG` and start the web app —
   it idempotently seeds the owner user + workspace on startup.
4. The owner signs in at `/login` with the org + an Azure DevOps PAT (validated against
   Azure DevOps; stored encrypted). Any valid PAT holder in an enabled org is
   auto-provisioned as a `member`.
5. An owner/admin sets the **workspace sync credential** (`POST /api/workspace/sync-credential`)
   — a service-account / admin PAT the worker uses for scheduled sync.

## Credentials & data model

- **Private per user (encrypted):** Azure DevOps PAT, LLM API key, LLM provider/model.
  Interactive actions (analysis, test design, bug reports, publishing) use the
  current user's PAT/LLM key — the Azure DevOps audit trail reflects the real user.
- **Shared per workspace:** synced Azure project data, Knowledge Hub, dashboards,
  history, activity/audit logs, analysis/test runs. Every shared row carries
  `workspace_id`.
- **Workspace sync credential:** used by the worker for scheduled sync (no logged-in
  user), separate from any individual's PAT.
- Secrets are **never** returned to the frontend (masked preview + status only) and
  are redacted from logs.

## Production checklist

- [ ] HTTPS enabled (cookies are `Secure` in production).
- [ ] `APP_MODE=hosted` so env credentials cannot act as shared globals.
- [ ] `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `BOOTSTRAP_OWNER_*` set via secrets.
- [ ] Migrations run on deploy (`npm run db:migrate`).
- [ ] web and worker both running; worker has `DATABASE_URL` + `APP_ENCRYPTION_KEY`.
- [ ] PostgreSQL automated backups enabled (see below).
- [ ] Reverse proxy forwards `X-Forwarded-For` (rate limiting keys on client IP).

## Backups & restore

All durable state is in PostgreSQL — back it up (managed automated backups, or
`pg_dump`). No application state lives on the filesystem (temporary files/exports only).

```bash
# Backup
pg_dump "$DATABASE_URL" -Fc -f itestflow-$(date +%F).dump
# Restore (into a fresh database)
pg_restore --clean --if-exists -d "$DATABASE_URL" itestflow-YYYY-MM-DD.dump
```

## Local development

```bash
docker compose up -d postgres     # Postgres only (Docker not required for the app)
npm run db:migrate
npm run dev                        # web app
npm run worker:dev                 # worker (separate terminal; loads .env)
```

Developers may skip Docker by pointing `DATABASE_URL` at a native PostgreSQL.
Integration tests run against PostgreSQL when `DATABASE_URL` is set; otherwise the
DB-backed suites are skipped and only pure-logic unit tests run.

## Migrations

`node-pg-migrate` (`migrations/`), same SQL locally and hosted.

```bash
npm run db:migrate            # apply
npm run db:migrate:down       # revert one
npm run db:reset-dev          # revert all then re-apply (dev only)
```
