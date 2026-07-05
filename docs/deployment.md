# iTestFlow Private Hosted Deployment Guide

iTestFlow runs as a privately hosted, multi-user workspace application. Each company hosts its own instance and shares the URL only with internal users. This guide covers the production topology, required configuration, first-run flow, operations, and local development.

For source layout and module boundaries, see [Project Architecture](../PROJECT_ARCHITECTURE.md).

## Services

A deployment runs three service types:

| Service | Command | Purpose |
| --- | --- | --- |
| web | `npm run build` then `npm run start` | Next.js app, pages, and API routes |
| worker | `npm run worker` | Background jobs, scheduled Azure DevOps sync, indexing, and job recovery |
| postgres | managed or self-hosted PostgreSQL 16+ | All durable application data and job queue state |

The web app and worker are independent Node processes that share PostgreSQL. Multiple web replicas and multiple workers are supported. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, heartbeat active work, and requeue stale locks, so a job is not intentionally processed by more than one live worker.

## Required Environment Variables

Set these via the hosting platform's secrets or a secret manager, not through the UI. See [.env.example](../.env.example).

iTestFlow supports two bootstrap modes:

### Single-Org Mode

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOOTSTRAP_OWNER_EMAIL` | yes | Initial owner identity, seeded idempotently at startup |
| `BOOTSTRAP_OWNER_AZURE_ORG` | yes | Initial enabled Azure DevOps organization/workspace URL |

### Multi-Org Mode

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOOTSTRAP_AZURE_ORGS` | yes | Comma-separated `orgUrl\|ownerEmail` entries. Each org has its own owner. Omit `\|email` to inherit `BOOTSTRAP_OWNER_EMAIL`. When set, takes precedence over `BOOTSTRAP_OWNER_EMAIL`/`BOOTSTRAP_OWNER_AZURE_ORG`. |

### Common Variables (Both Modes)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DATABASE_POOL_MAX` | optional | Max PostgreSQL connections per process, default `10` |
| `APP_ENCRYPTION_KEY` | yes | Base64-encoded 32-byte key used to encrypt stored PATs and LLM keys |
| `SESSION_SECRET` | optional | Reserved for cookie HMAC hardening; stateful sessions do not require it today |
| `CREDENTIAL_STALE_DAYS` | optional | Age threshold for credential freshness warnings, default from app code |
| `WORKER_SCHEDULER` | optional | Set `false` to disable worker cron scheduling, default enabled |
| `WORKER_SCHEDULER_TICK_MS` | optional | How often due schedules are evaluated, default `60000` |
| `WORKER_POLL_MS` | optional | Worker idle poll interval, default `2000` |
| `WORKER_HEARTBEAT_MS` | optional | Active-job heartbeat interval, default `30000` |
| `JOB_STALE_LOCK_MS` | optional | Stale lock recovery threshold, default `300000` |
| `RATE_LIMIT_BACKEND` | optional | `postgres` (shared multi-replica) or `memory` (per-process). Defaults to `postgres` when `NODE_ENV=production`, else `memory` |
| `RATE_LIMIT_TRUSTED_PROXY_HOPS` | optional | Reverse proxies in front of the app; login throttling reads the client IP this many hops from the right of `X-Forwarded-For`. Default `0` |
| `PROJECT_CONTEXT_TOP_K` | optional | Default RAG retrieval breadth, default `8`, clamped by app code |
| `LLM_MAX_OUTPUT_TOKEN_CAP` | optional | Deployment default output-token cap. Workspace settings can override allowed caps |

Generate an encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store `APP_ENCRYPTION_KEY` outside the database. Without the same key, encrypted PATs and LLM keys cannot be decrypted after restore. Do not replace `APP_ENCRYPTION_KEY` in place for an existing database; add a versioned key path and re-encrypt stored secrets before retiring the old key.

## Per-User And Workspace Settings

Each user stores private credentials in Settings:

- Azure DevOps PAT
- LLM provider
- LLM model
- LLM API key
- Optional provider base URL where supported

Owners/admins manage workspace-level settings:

- Workspace members and roles
- Context retrieval top-K override
- LLM max output token cap
- LLM retry attempts
- Workspace sync credential
- Workspace sync schedule and filters

Interactive actions use the current user's Azure DevOps PAT and LLM key. Scheduled sync uses the workspace sync credential because no user is present.

## First Run

### Single-Org Setup

1. Provision PostgreSQL and set `DATABASE_URL`.
2. Set `APP_ENCRYPTION_KEY`, `BOOTSTRAP_OWNER_EMAIL`, and `BOOTSTRAP_OWNER_AZURE_ORG`.
3. Run migrations as a deploy/release step:

   ```bash
   npm run db:migrate
   ```

4. Build and start the web service:

   ```bash
   npm run build
   npm run start
   ```

5. Start at least one worker:

   ```bash
   npm run worker
   ```

6. The bootstrap process idempotently seeds the owner user, workspace, and owner membership on startup.
7. The owner signs in at `/login` with the enabled Azure DevOps organization and a valid PAT.
8. The owner adds private LLM credentials from `/settings`.
9. The owner selects an active Azure DevOps project from the top bar. The server verifies and stores the project anchor before project-scoped routes can use it.
10. An owner/admin sets the workspace sync credential and, optionally, a sync schedule in Settings.

The app startup instrumentation also attempts pending migrations and bootstrap seeding. Keep the explicit migration step anyway so schema failures are caught before serving traffic.

### Multi-Org Setup

1. Provision PostgreSQL and set `DATABASE_URL`.
2. Set `APP_ENCRYPTION_KEY` and `BOOTSTRAP_AZURE_ORGS` with comma-separated `orgUrl|ownerEmail` entries:

   ```
   BOOTSTRAP_AZURE_ORGS=https://dev.azure.com/org-a|admin@company.com, https://dev.azure.com/org-b|owner-b@company.com
   ```

3. Run migrations as a deploy/release step:

   ```bash
   npm run db:migrate
   ```

4. Build and start the web service:

   ```bash
   npm run build
   npm run start
   ```

5. Start at least one worker:

   ```bash
   npm run worker
   ```

6. The bootstrap process idempotently seeds each organization, its owner user, and owner membership on startup.
7. Each org owner signs in at `/login`, selects their organization from the list (or enters it by URL), and authenticates with a PAT.
8. Each owner adds private LLM credentials from `/settings`.
9. Each owner selects an active Azure DevOps project from the top bar. The server verifies and stores the project anchor before project-scoped routes can use it.
10. Each org admin sets workspace sync credentials and, optionally, sync schedules in Settings.

The same startup-instrumentation note applies: keep the explicit `npm run db:migrate` step in the deploy pipeline so schema failures surface before serving traffic.

### Managing Organizations

Once an org is seeded, it cannot be removed via environment variable changes. To temporarily disable an org without losing data:

```bash
npm run org:disable -- <orgUrlOrName>
```

To re-enable a previously disabled org:

```bash
npm run org:enable -- <orgUrlOrName>
```

These operations are reversible and preserve all workspace data, user records, project anchors, indexed context, and activity history.

## Credentials And Data Model

- Private per user/workspace: Azure DevOps PAT, LLM provider/model/base URL, and LLM API key.
- Shared per workspace: project anchors, synced project context, compiled knowledge, dashboards, workflow analytics, activity logs, audit logs, jobs, workspace settings, and member records.
- Workspace sync credential: encrypted service/admin PAT used by the worker for scheduled sync.
- Sessions: opaque cookie token in the browser, SHA-256 token hash in PostgreSQL.
- Secrets are never returned to the frontend in plain text and should be redacted from logs.

## Production Checklist

- [ ] HTTPS is enabled.
- [ ] `DATABASE_URL`, `APP_ENCRYPTION_KEY`, and bootstrap variables (`BOOTSTRAP_OWNER_EMAIL`/`BOOTSTRAP_OWNER_AZURE_ORG` or `BOOTSTRAP_AZURE_ORGS`) are set through secrets.
- [ ] `npm run db:migrate` runs before the new web/worker version receives traffic.
- [ ] At least one web process is running.
- [ ] At least one worker process is running with `DATABASE_URL` and `APP_ENCRYPTION_KEY`.
- [ ] PostgreSQL automated backups are enabled and restore has been tested.
- [ ] Reverse proxy forwards client IP headers if rate limiting should key by real client IP.
- [ ] `RATE_LIMIT_BACKEND=postgres` is set when running more than one web replica.
- [ ] Worker logs are monitored for repeated job failures or stale-lock recovery.
- [ ] `APP_ENCRYPTION_KEY` is backed up in a secure secret store separate from PostgreSQL backups.
- [ ] For multi-org deployments, verify that each org's owner can sign in and that org enable/disable scripts are accessible if needed.

## Multi-Replica Notes

Use `RATE_LIMIT_BACKEND=postgres` with multiple web replicas so login and credential rate limits are shared. The default memory backend is per-process and is acceptable only for one web replica or local development.

Workers can scale horizontally. Keep job handlers idempotent where possible because failed or stale jobs can be retried.

Before redeploying workers, drain or gracefully stop the old worker pool so in-flight sync jobs can finish. If a worker is terminated mid-job, the replacement worker recovers it through stale-lock requeue after `JOB_STALE_LOCK_MS` (5 minutes by default), so scheduled sync can appear delayed during that window.

## Backups And Restore

All durable application state lives in PostgreSQL. Back it up with managed automated backups or `pg_dump`.

```bash
# Backup
pg_dump "$DATABASE_URL" -Fc -f itestflow-$(date +%F).dump

# Restore into a fresh database
pg_restore --clean --if-exists -d "$DATABASE_URL" itestflow-YYYY-MM-DD.dump
```

After restore:

1. Confirm the restored environment has the same `APP_ENCRYPTION_KEY`.
2. Run `npm run db:migrate`.
3. Start the web service and worker.
4. Sign in and verify workspace/project selection, credential status, dashboard reads, and a small Knowledge Hub status read.

Rollback past migration `1710000007000_project_anchor_backfill` is backup-based. That migration canonicalizes project IDs and cannot reconstruct prior IDs through `db:migrate:down`; restore a pre-migration PostgreSQL backup instead.

## Local Development

```bash
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run dev -- --hostname 127.0.0.1 --port 3000
npm run worker:dev
```

Developers may skip Docker by pointing `DATABASE_URL` at a native PostgreSQL instance. Docker is required only for the provided local PostgreSQL service, disposable test database, or pgAdmin profile.

Optional local services:

```bash
docker compose --profile test up -d
docker compose --profile tools up -d
```

## Migrations

Migrations use `node-pg-migrate` and live in `migrations/`.

```bash
npm run db:migrate
npm run db:migrate:down
npm run db:reset-dev
```

Use `npm run db:reset-dev` only against disposable development databases.

## Verification

Recommended pre-release checks:

```bash
npm run typecheck
npm run test:unit
npm run test:coverage
npm run test:integration
npm run build
```

The unit and gated coverage suites are fully local and mock external boundaries.
The integration suite requires `DATABASE_URL` and a migrated PostgreSQL database;
it exits immediately instead of silently skipping when that prerequisite is absent.

## Docs Cleanup Guidance

Keep `docs/deployment.md` and `docs/knowledge-wiki-rag-enhancement.md` as durable references. Final architecture decisions should live in [Project Architecture](../PROJECT_ARCHITECTURE.md).
