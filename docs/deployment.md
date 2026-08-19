# iTestFlow Private Hosted Deployment Guide

iTestFlow runs as a privately hosted, multi-user workspace application. Each company hosts its own instance and shares the URL only with internal users. This guide covers the production topology, required configuration, first-run flow, operations, and local development.

For source layout and module boundaries, see [Project Architecture](../PROJECT_ARCHITECTURE.md).

## Services

The default topology runs two service types:

| Service | Command | Purpose |
| --- | --- | --- |
| application | `npm run build` then `npm start` | Supervises the Next.js app and background processing as one application unit |
| postgres | managed or self-hosted PostgreSQL 16+ | All durable application data and job queue state |

The application supervisor starts the web and background child processes, restarts an unexpectedly exited background process with bounded backoff, and stops both children when the application shuts down. The background child is stopped with a shutdown control message over its piped stdin, which triggers the same graceful drain-and-requeue path as SIGTERM on every OS — on Windows a signal kill is an abrupt `TerminateProcess` that would skip that path — and the supervisor falls back to a kill only if the child has not exited after the graceful window. Knowledge builds are accepted only while a capable process is healthy, so an unavailable generation path fails immediately instead of leaving a build queued indefinitely.

For independently scaled deployments, run `npm run web:start` and `npm run worker` as separate services. Both processes share PostgreSQL. Multiple web replicas and multiple background processes are supported; jobs are claimed with `FOR UPDATE SKIP LOCKED`, heartbeat active work, and requeue stale locks.

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
| `DATABASE_POOL_MAX` | optional | Max PostgreSQL connections per process, default `10`. Consider raising it on background processes expected to run many simultaneous knowledge builds |
| `APP_ENCRYPTION_KEY` | yes | Base64-encoded 32-byte key used to encrypt stored PATs and LLM keys |
| `SESSION_SECRET` | optional | Reserved for cookie HMAC hardening; stateful sessions do not require it today |
| `CREDENTIAL_STALE_DAYS` | optional | Age threshold for credential freshness warnings, default from app code |
| `WORKER_SCHEDULER` | optional | Set `false` to disable worker cron scheduling, default enabled |
| `WORKER_SCHEDULER_TICK_MS` | optional | How often due schedules are evaluated, default `60000` |
| `WORKER_POLL_MS` | optional | Worker idle poll interval, default `2000` |
| `WORKER_HEARTBEAT_MS` | optional | Active-job heartbeat interval, default `30000`; one batched heartbeat covers all of a worker's active jobs |
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
- Whether the manual External LLM copy/paste mode is available to workspace members
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

4. Build and start the application:

   ```bash
   npm run build
   npm run start
   ```

5. The bootstrap process idempotently seeds the owner user, workspace, and owner membership on startup.
6. The owner signs in at `/login` with the enabled Azure DevOps organization and a valid PAT.
7. The owner adds private LLM credentials from `/settings`.
8. The owner selects an active Azure DevOps project from the top bar. The server verifies and stores the project anchor before project-scoped routes can use it.
9. An owner/admin sets the workspace sync credential and, optionally, a sync schedule in Settings.

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

4. Build and start the application:

   ```bash
   npm run build
   npm run start
   ```

5. The bootstrap process idempotently seeds each organization, its owner user, and owner membership on startup.
6. Each org owner signs in at `/login`, selects their organization from the list (or enters it by URL), and authenticates with a PAT.
7. Each owner adds private LLM credentials from `/settings`.
8. Each owner selects an active Azure DevOps project from the top bar. The server verifies and stores the project anchor before project-scoped routes can use it.
9. Each org admin sets workspace sync credentials and, optionally, sync schedules in Settings.

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
- [ ] `npm run db:migrate` runs before the new application version receives traffic.
- [ ] At least one supervised application process is running, or the advanced split topology has at least one web process and one capable background process.
- [ ] PostgreSQL automated backups are enabled and restore has been tested.
- [ ] Reverse proxy forwards client IP headers if rate limiting should key by real client IP.
- [ ] `RATE_LIMIT_BACKEND=postgres` is set when running more than one web replica.
- [ ] Application logs are monitored for repeated background-process restarts, job failures, or stale-lock recovery.
- [ ] `APP_ENCRYPTION_KEY` is backed up in a secure secret store separate from PostgreSQL backups.
- [ ] For multi-org deployments, verify that each org's owner can sign in and that org enable/disable scripts are accessible if needed.

## Multi-Replica Notes

Use `RATE_LIMIT_BACKEND=postgres` with multiple web replicas so login and credential rate limits are shared. The default memory backend is per-process and is acceptable only for one web replica or local development.

The default supervised application can scale horizontally. Queue locking prevents replicas from intentionally claiming the same live job. Use the split `web:start` and `worker` topology when web and background capacity need to scale independently. Keep job handlers idempotent because failed or stale jobs can be retried.

Knowledge Hub builds (`project_knowledge_build`) for different projects and organizations do not block one another: each background process starts every ready build immediately and runs them concurrently, while workspace sync and other job types stay on a separate serial lane. One active build per project is still enforced through the queue's dedupe key. LLM provider throttling (429/`Retry-After`) can delay individual LLM requests inside a build, but it does not stall sibling projects' builds; transient retries are jittered so concurrent builds do not retry a throttled provider in lockstep.

Before redeploying split background services, gracefully stop the old pool (SIGTERM). A stopping process unregisters its capacity, gives active jobs three seconds to finish, then aborts and atomically requeues the unfinished ones without consuming a retry, so a surviving process picks them up immediately. Under the supervised `npm start`/`npm run dev` topology, the supervisor triggers the identical path on every OS by writing a shutdown message to the background child's stdin (Windows has no graceful signal delivery). If a process is killed without the graceful path, its replacement recovers the job through stale-lock requeue after `JOB_STALE_LOCK_MS` (5 minutes by default) — that recovery consumes one attempt, and scheduled sync can appear delayed during the window.

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
3. Start the supervised application, or both services in the advanced split topology.
4. Sign in and verify workspace/project selection, credential status, dashboard reads, and a small Knowledge Hub status read.

Rollback past migration `1710000007000_project_anchor_backfill` is backup-based. That migration canonicalizes project IDs and cannot reconstruct prior IDs through `db:migrate:down`; restore a pre-migration PostgreSQL backup instead.

## Local Development

### Playwright MCP execution

Workspace owners and admins configure Streamable HTTP or stdio from Settings. HTTP endpoints require HTTPS except for localhost, may not contain URL credentials, and remote origins must appear in the comma-separated `PLAYWRIGHT_MCP_HTTP_ALLOWED_ORIGINS` deployment setting. Saving validates the MCP connection and its required navigation, snapshot, and tab-inspection tools before persistence. A bearer token is optional and encrypted with `APP_ENCRYPTION_KEY`; an artifact base URL restricts protected trace imports to the configured origin and path prefix. Signed artifact query parameters are used only for the immediate download; durable artifact provenance contains origin and path only. Streamable HTTP redirects are rejected for every transport request.

Stdio is deployment-managed. Set `PLAYWRIGHT_MCP_STDIO_COMMAND` and a JSON string array in `PLAYWRIGHT_MCP_STDIO_ARGS`; these values are never accepted from the browser. The command must start a compatible Playwright MCP server already installed in the deployment. Stdio spawn strips `--no-sandbox` from those args and omits `PLAYWRIGHT_MCP_NO_SANDBOX` from the child environment unless `PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX=true`. When `NODE_ENV=production`, also set `PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX_IN_PRODUCTION=true` or the override is still stripped. HTTP MCP cannot control Chrome flags on a remote server; remote Playwright MCP servers must not enable `--no-sandbox` unless similarly authorized. Configure comma-separated exact browser target origins in `PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS`; direct agent-requested navigation fails closed when this list is empty, and arbitrary page-code evaluation is not exposed. Set it to `*` to remove the navigation boundary entirely and let the agent visit any origin — this is a deployment-operator opt-in only (never exposed in workspace settings), since it removes the only runtime control on where an LLM-driven browser session can navigate; use it only for trusted, isolated deployments. The worker verifies every open tab before dispatch, after successful or rejected tool calls, and before accepting step completion; a disallowed or ambiguous tab state is discarded before reuse or persistence. Optional stdio file uploads require absolute regular files below one of the deployment-managed roots in the JSON array `PLAYWRIGHT_EXECUTION_UPLOAD_ROOTS`; HTTP MCP uploads remain disabled. Upload paths, tool results, and filesystem-policy failures are path-free before persistence or reuse as model context. These client-side checks are defense in depth, not an atomic browser-network boundary: deployment egress filtering must still block application redirects and navigation caused by interactions with the tested page. Every test case gets a fresh MCP session, cases run serially, and the reusable PostgreSQL worker must advertise the `playwright_mcp_execution` capability.

Apply `npm run db:migrate` before enabling the feature. Execution history and metadata remain until workspace deletion; content-addressed artifacts use `DOCUMENT_STORAGE_ROOT`. Azure Test Point outcomes are written only when a user clicks **Publish reviewed results**.

Set `PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS` identically for the web and worker processes. The run-creation API pre-checks the user's Base URL against this list only when the variable is present in the web process; the worker is the hard enforcement point. If the two processes diverge, a run can queue successfully and then fail at its first navigation with "The Base URL is not on an allowed test origin for this deployment."

```bash
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Developers may skip Docker by pointing `DATABASE_URL` at a native PostgreSQL instance. Docker is required only for the provided local PostgreSQL service, disposable test database, or pgAdmin profile.

`npm run dev` starts both application processes. For advanced split-process debugging, use `npm run web:dev` in one terminal and `npm run worker:dev` in another.

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

### Repairing a fork-era migration history

A database migrated from a pre-merge fork branch can fail `npm run db:migrate` (and application startup, which runs the same check) with:

```
Error: Not run migration <name> is preceding already run migration <name>
```

This happens because two unrelated migrations once claimed the same timestamps and were later renumbered; the database's recorded history still carries the old filenames. Run the one-time repair, then migrate:

```bash
npm run db:fix-migration-history
npm run db:migrate
```

The repair renames the affected history records to the current filenames, removes records for migrations that were reverted before ever shipping, applies either workspace-settings migration when the history proves it was skipped, and re-canonicalizes the recorded order. It is idempotent and safe to run on fresh, healthy, or already-repaired databases — it reports "not present" for anything that does not need fixing. Fresh installs and databases only ever migrated from `main` never need it.

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
The integration suite requires `TEST_DATABASE_URL` and a migrated disposable PostgreSQL
database; it exits immediately instead of silently skipping when that prerequisite is
absent. Run `npm run db:migrate:test` before the suite. Integration commands never use
the application's `DATABASE_URL`, preventing test fixtures from leaking into the app.

## Docs Cleanup Guidance

Keep `docs/deployment.md` and `docs/knowledge-wiki-rag-enhancement.md` as durable references. Final architecture decisions should live in [Project Architecture](../PROJECT_ARCHITECTURE.md).
