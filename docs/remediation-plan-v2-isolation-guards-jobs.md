# Remediation Plan v2 — Workspace Isolation, API Guards, Job Recovery

> **Status:** v2, revised after a code-grounded review of v1. Closes findings **F1, F3, F4, F5, F6** fully and **F2** defensibly. F7 (CI) and F8 (docs) remain follow-ups.
>
> **What changed from v1:** three blockers were resolved (project-id orphaning, resolver coverage, missing backfill), the upsert/reaper SQL was made concrete and correct against the real schema, R3 gained a heartbeat + locked_by fencing, R4 gained the tests v1 omitted, and the "build failure" follow-up was reclassified as a cosmetic warning. See **§7 Changelog**.

---

## 1. Summary

Implement the first remediation batch covering the highest-value clusters: **F1/F2/F4 isolation**, **F3/F5 auth-guard sweep**, and **F6 worker reaper**. No new npm packages. Keep the existing client `scope` request shape, but make the server resolve canonical workspace/project authority and **ignore client Azure fields for all trust decisions**.

The core architecture is the **trusted project resolver** that already exists on the worker path ([workspace-sync.handler.ts:23-32](../src/modules/jobs/workspace-sync.handler.ts#L23-L32)) — `SELECT … FROM projects WHERE id=@projectId AND workspace_id=@workspaceId`, scope rebuilt from the DB row. v2 lifts that exact pattern onto the interactive path and applies it to **every** scope-consuming route.

---

## 2. Hard invariants (non-negotiable — getting any wrong loses data or leaves F4 open)

### INV-1 — `projects.id` **equals the Azure project GUID**
Today every feature table is keyed by `project_id = azureProjectId = the Azure GUID` (the client sets `projectId === azureProjectId === first.id`, [project-status.tsx:37-43](../src/shared/components/live/project-status.tsx#L37-L43) and `:83-89`; the GUID originates at [azure-devops-client.ts:188](../src/modules/integrations/azure-devops/azure-devops-client.ts#L188)). `createId("proj")` mints `proj_<uuid>`, which can **never** equal a GUID. Therefore the anchor upsert **must** set `projects.id := azureProjectId`. The resolver **must** return `scope.projectId === azureProjectId`. This avoids any feature-data migration on the interactive path. **Do not** mint a new token id.

### INV-2 — the trusted resolver is mandatory on **all 56 scope-consuming routes**, not the 16
F4 lives in every route that trusts client `scope`. `requireWorkflowContext` validates **workspace membership only** — never project→workspace ownership ([scoped-resolution.service.ts:46-60](../src/modules/credentials/scoped-resolution.service.ts#L46-L60), whose own doc comment flags this as deferred). The **40 already-guarded routes** still pass raw `parsed.data.scope` into `getUserAzureAdapter`/feature services. Closing F4 only on the unguarded 16 leaves the real attack surface open. Every route that parses `ProjectScope` must route through `resolveProjectScope(ctx, clientScope)` and pass the **returned trusted scope** downstream — never `parsed.data.scope`.

### INV-3 — server-authoritative fields come from `ctx.workspace`, never the client
`azure_organization_url` for the anchor upsert and the live adapter must be `ctx.workspace.azureOrgUrl` (already trusted/normalized). `workspace_id` must be set **explicitly** to `ctx.workspace.id` (do not rely on the trigger, which silently leaves NULL on an org-string mismatch — [1710000003000:78-82](../migrations/1710000003000_workspace_scoping.js#L78-L82)).

### INV-4 — migrations run **before** code deploy
The `workspace_id` columns/triggers and the `jobs` table exist only on `multi-user-self-hosted`. Resolver/guard code that expects them must not ship before migrations `1710000003000` + `1710000004000` and the **projects backfill** (§3 R1.5) have run.

---

## 3. Key Changes

### R1 — Workspace Project Anchor + Trusted Resolver

**R1.1 — Anchor service (`projects` writer).** New server-side service that persists used/selected Azure projects into `projects`. Idempotent upsert keyed on the **only** unique constraint that exists, `UNIQUE(azure_organization_url, azure_project_id)` ([initial_schema:36](../migrations/1710000000000_initial_schema.js#L36)):

```sql
INSERT INTO projects (id, azure_project_id, azure_project_name, azure_organization_url, name, status, workspace_id, created_at, updated_at)
VALUES (@azureProjectId, @azureProjectId, @azureProjectName, @orgUrl, @azureProjectName, 'active', @workspaceId, @now, @now)
ON CONFLICT (azure_organization_url, azure_project_id)
DO UPDATE SET azure_project_name = EXCLUDED.azure_project_name, workspace_id = EXCLUDED.workspace_id, updated_at = EXCLUDED.updated_at
RETURNING id;
```
- `id := azureProjectId` (INV-1). `@orgUrl := ctx.workspace.azureOrgUrl`, `@workspaceId := ctx.workspace.id`, `@azureProjectName` derived from `fetchProjects()` (INV-3) — never client values.
- Conflict target is `(azure_organization_url, azure_project_id)` — **not** any `workspace_id` pair (no such unique index exists; that would throw at runtime).

**R1.2 — Project-selection API.** `POST /api/azure-devops/project/select` (or similar). Client sends `{ workspaceId?: string; azureProjectId: string }`. Server: `requireWorkflowContext(workspaceId)` → build **org-level** adapter `getUserAzureAdapterOrgLevel(ctx)` (already exists, [scoped-resolution.service.ts:81-94](../src/modules/credentials/scoped-resolution.service.ts#L81-L94)) → verify `azureProjectId` is in `fetchProjects()` output (no `getProject` primitive exists; the org list is the verification call) → derive the canonical `azureProjectName`/casing from that result → run the R1.1 upsert → return the trusted `ProjectScope`. Surface missing/expired PAT via the existing `authErrorResponse` mapping (401/400).

**R1.3 — Canonical resolver (`resolveProjectScope`).** Accepts `(ctx, clientScope)`. Resolves the `projects` row by `(id = clientScope.projectId, workspace_id = ctx.workspace.id)`, falling back to `(azure_project_id = clientScope.azureProjectId, workspace_id = ctx.workspace.id)`. On miss: **throw 403/404, never fall back to trusting the client scope.** On hit: return a `ProjectScope` rebuilt entirely from the DB row + `ctx.workspace`. If the row is absent but the project verifies via Azure (R1.2 path), lazily upsert then return — so first-use self-heals. This mirrors [workspace-sync.handler.ts:29](../src/modules/jobs/workspace-sync.handler.ts#L29).

**R1.4 — `getUserAzureAdapter` hardening.** Change its signature so it cannot be built from unverified client identity: have it take a resolved `projectId` (or call `resolveProjectScope` internally given `ctx` + `projectId`). Update the doc comment at [scoped-resolution.service.ts:20-23](../src/modules/credentials/scoped-resolution.service.ts#L20-L23) which currently codifies the unsafe behavior.

**R1.5 — Backfill migration (prevents scheduled-sync regression).** In the same migration window, create `projects` rows for every distinct `(azure_organization_url, azure_project_id)` already present in feature tables, with `id = azure_project_id`, `status='active'`, `workspace_id` resolved from the org. Without this, `enqueueWorkspaceContextSync` ([workspace-sync.handler.ts:67](../src/modules/jobs/workspace-sync.handler.ts#L67)) selects zero active projects and **scheduled sync silently stops** until each project is manually re-selected.

**R1.6 — Reconcile the worker/interactive id split.** The worker currently keys feature rows by a `createId` token while interactive rows use the GUID. Converge both on `id = GUID`: update the worker/enqueuer seed path, and add a one-time re-key migration `UPDATE <feature> SET project_id = p.azure_project_id FROM projects p WHERE <feature>.project_id = p.id` for any worker-written rows. Add an R4 test asserting interactive and scheduled writes collide on the same `project_id`.

**R1.7 — localStorage.** Because of INV-1, `projectId` stays equal to `azureProjectId`, so existing `localStorage` (`itestflow.activeProject`) needs **no** client migration. R1(d)'s "canonical internal projectId" is a semantic clarification only (same value). The resolver's `azureProjectId` fallback is **permanent**, not transitional.

### R2 — API Guard + Side-Effect Sweep

- Add `requireWorkflowContext` + `resolveProjectScope` to the **16 protected-unguarded routes**: `activity-log`, `dashboard/system-analytics`, `context/status`, the `context/knowledge/*` set (`export, lint, log, status, promote, save`, `manual/{draft,finalize,validate,consolidation}`), and the **3** unguarded `manual/submit` routes — `bugs/manual/submit`, `requirement-analysis/manual/submit`, `test-cases/manual/submit`. **Do not** touch `test-execution-effort/manual/submit` or `existing-test-case-review/manual/submit` — they are already guarded (replace the `*/manual/submit` wildcard with this explicit 3-route list).
- Per INV-2, also migrate the **40 already-guarded routes** to pass the resolved trusted scope (from `resolveProjectScope`) into `getUserAzureAdapter`/feature services instead of `parsed.data.scope`.
- **Move every `startWorkflowRun(...)` after** session/workspace/project resolution; declare `let analyticsRunId` outside the `try` ([test-cases/generate](../src/app/api/azure-devops/test-cases/generate/route.ts) is the working template).
- Pass `ctx.userId` into workflow analytics and **remove the `'local-user'` default** in `startWorkflowRun` so no analytics/audit row is written without an authenticated principal.
- **`activity-log` carve-out:** its scope is `.optional().nullable()` ([activity-log/route.ts:10](../src/app/api/activity-log/route.ts#L10)) and the service treats null `projectId` as match-all across every workspace ([activity-log.service.ts:60](../src/modules/activity-log/activity-log.service.ts#L60)). Require session + primary-workspace fallback; **remove the null→match-all branch** and scope the read to `ctx.workspace.id`. Do not require a resolved `projectId` here.
- **`dashboard/system-analytics`:** authorize the client-supplied `filters.userId` ([route.ts:22](../src/app/api/dashboard/system-analytics/route.ts#L22)) — only owner/admin may query another user; otherwise force `userId = ctx.userId`.
- **Public whitelist (explicit, exhaustive):** `auth/login`, `auth/session` (returns `{authenticated:false}` via `getOptionalSession` — stays public, must keep returning that, not 401), `health`. Leave `workspace/*` routes as-is — they guard via `resolveWorkspaceRequest` (correct; uses the user's primary workspace).

### R3 — Worker Stale-Lock Reaper

`locked_at` is `text` (ISO-8601 UTC), `attempts` is incremented at **claim** ([job-queue.service.ts:132](../src/modules/jobs/job-queue.service.ts#L132)), and `completeJob`/`failJob` match `WHERE id` only ([:144](../src/modules/jobs/job-queue.service.ts#L144)/[:165](../src/modules/jobs/job-queue.service.ts#L165)). The reaper must account for all of that:

**R3.1 — Heartbeat (required; not optional).** There is no heartbeat today, so `locked_at` = *claim time*, and a legitimately long `workspace_context_sync` (unbounded fetch + single transaction, [project-context-store.service.ts:155-316](../src/modules/rag/project-context-store.service.ts#L155-L316)) can exceed any fixed timeout and be reaped while alive → **concurrent double-execution** (the handler is *not* concurrency-safe). Add a worker heartbeat that refreshes `locked_at` every ~30–60s while the handler runs:
```sql
UPDATE jobs SET locked_at = @now WHERE id = @id AND locked_by = @workerId;
```
Set `JOB_STALE_LOCK_MS` to a small multiple of the heartbeat interval (**~5 min**, not 1h).

**R3.2 — Atomic requeue (single statement, no select-then-update).** Run before claiming, race-safe by construction:
```sql
-- requeue stale-but-retriable
UPDATE jobs SET status='pending', locked_by=NULL, locked_at=NULL, run_after=@now, updated_at=@now
WHERE status='running' AND locked_at IS NOT NULL AND locked_at < @threshold AND attempts < max_attempts;
-- fail stale-and-exhausted
UPDATE jobs SET status='failed', finished_at=@now, locked_by=NULL, error_message='stale lock reclaimed', updated_at=@now
WHERE status='running' AND locked_at IS NOT NULL AND locked_at < @threshold AND attempts >= max_attempts;
```
`@threshold = nowIso() - JOB_STALE_LOCK_MS` (ISO string compare is valid for UTC ISO-8601). `running→pending` keeps the `uq_jobs_active_dedupe` slot; `running→failed` frees it — both intended.

**R3.3 — attempts accounting.** Since claim always increments `attempts`, a reaped slow-but-healthy job would burn retry budget. Either **decrement `attempts` on requeue** (net-neutral with the next claim's increment) or move the increment out of claim into the retry path only. Pick one and state it.

**R3.4 — `locked_by` fencing.** Add `AND locked_by = @workerId` to `completeJob` and `failJob` (thread `workerId` through [worker/main.ts](../src/worker/main.ts)). A reaped worker's late return then becomes a 0-row no-op instead of clobbering the new owner.

### R4 — Verification

DB-backed tests (gated by `DATABASE_URL`; add a shared `src/test/db.ts` exporting `describeDb` + a `withWorkspaceFixture` helper rather than copy-pasting the inline gate):

1. **Anchor/resolver identity (INV-1):** upsert sets `projects.id = azureProjectId`; resolver returns `projectId === GUID`; legacy feature rows keyed by the GUID still resolve (not orphaned).
2. **`workspace_id` trigger:** positive (projects row present → feature row gets `workspace_id`) **and** negative (project_id absent → `workspace_id` stays NULL, documenting the trigger fails open).
3. **Cross-workspace rejection (F4):** member of workspace A; `resolveProjectScope` called with a `projectId` whose row has `workspace_id=B` → 403/404, **no** fallback to client identity. Drive at least one *guarded* route (e.g. `requirement-analysis/run`) with a foreign `azureProjectId` and assert 403, not a successful Azure call.
4. **Cross-workspace read filtering (F2):** confirm reads scoped via the trusted resolver don't return another workspace's rows; `activity-log` null-scope no longer matches all.
5. **Pre-auth side effect (F5):** unauthenticated `manual/submit` → `await flushBackgroundWrites()` → assert **0 rows** in `analytics_workflow_runs` **and** `audit_logs`; authenticated → exactly one row with the real `userId` (not `local-user`).
6. **Reaper (F6):** (a) `locked_at < threshold AND attempts<max` → requeued; (b) `… AND attempts>=max` → failed, not requeued; (c) within threshold → left running. Force staleness by direct `UPDATE locked_at` (same pattern the existing job-queue test uses for `run_after`).
7. **Worker/interactive id collision (R1.6):** interactive and scheduled writes for the same Azure project share one `project_id`.
8. **Static route-guard test (fail-closed):** glob all `route.ts` under `src/app/api`; each must either reference a symbol in `GUARD_SYMBOLS = {requireWorkflowContext, requireSession, resolveWorkspaceRequest, getOptionalSession}` or be in `PUBLIC_ROUTES = {auth/login, auth/session, health}`. Assert the whitelist contains no stale paths. Document that the guarantee is "module references a guard," paired with the runtime tests above.
9. **Guarded-route scope lint:** a static/AST check that fails CI if any `route.ts` passes `parsed.data.scope` into `getUserAzureAdapter`/a feature service — only a resolved trusted scope variable is permitted.

Run: `typecheck`, `test`, DB-backed tests with `DATABASE_URL`, `build`.

---

## 4. Public interfaces & types

- **No new npm packages.**
- Keep existing client `scope` payloads compatible (INV-1 makes this free).
- New: `POST /api/azure-devops/project/select` accepting `{ workspaceId?: string; azureProjectId: string }`, returning the canonical trusted `ProjectScope`.
- New internal: `resolveProjectScope(ctx, clientScope): Promise<ProjectScope>` (throws `WorkflowAuthError` 403/404 on ownership miss). All feature routes consume its return value, never `parsed.data.scope`.
- Changed: `getUserAzureAdapter` no longer accepts raw client `{azureProjectId, azureProjectName}` — takes a resolved reference (R1.4).

---

## 5. Rollout & ordering

1. Land/confirm migrations `1710000003000` (workspace_id + triggers) and `1710000004000` (jobs).
2. Run the **projects backfill** (R1.5) and the worker re-key migration (R1.6) in that same window.
3. **Then** deploy R1–R3 code (INV-4). R1 (resolver) must precede R2 (guards call the resolver).
4. No client/localStorage migration needed (INV-1/R1.7).

---

## 6. Follow-up tickets (deferred, not in this batch)

- **F7 — CI:** add CI with a Postgres service, run migrations, then run the DB-backed Vitest suites (there is **no CI in the repo today**, so the 8 DB-backed suites never run automatically).
- **F8 — Docs:** rewrite README (it still describes SQLite / `data/runtime-settings.json` / a `/setup` config screen, all removed) **and** prune `.env.example` (its `APP_MODE` / single-user env-credential block is consumed by **no** code — genuine drift, not just README).
- **Build hygiene (reclassified):** there is **no production build failure** — `next build` succeeds (88/88 routes). The `experimental.nodeMiddleware` line is a cosmetic Next 15.5 config-schema warning (the same build prints `Experiments: ✓ nodeMiddleware`). **Do not remove the flag** — it keeps `pg` out of the Edge bundle. Optionally bump `package.json` `next: ^15.1.4` → `^15.5.0` to match the 15.5.15 the design requires. Not a prerequisite for R1–R3.

---

## 7. Changelog (v1 → v2)

- **INV-1 added** — `projects.id = Azure GUID`; v1's "canonical server-generated projectId" would have orphaned all feature data.
- **INV-2 added** — resolver applies to all 56 scope-consuming routes; v1 scoped it to the 16 unguarded, leaving F4 open on the 40 guarded routes.
- **R1.5 backfill added** — v1 omitted it; without it scheduled sync silently stops post-deploy.
- **R1 upsert corrected** — ON CONFLICT on `(azure_organization_url, azure_project_id)`, server-trusted org URL + explicit `workspace_id` (v1's implied workspace-pair conflict target would throw).
- **R1.2 verification primitive named** — `getUserAzureAdapterOrgLevel` + `fetchProjects`; derive name from Azure (v1's `{workspaceId, azureProjectId}`-only payload lacked the load-bearing project name).
- **R1.4/R1.6 added** — harden `getUserAzureAdapter`; reconcile worker/interactive id split.
- **R3 amended** — heartbeat + ~5 min threshold (v1's fixed 1h/no-heartbeat causes concurrent execution), atomic requeue, attempts accounting, `locked_by` fencing.
- **R2 tightened** — explicit 3-route `manual/submit` list, `activity-log`/`system-analytics` carve-outs, drop `local-user` default, full guard-symbol set.
- **R4 expanded** — F5 zero-row test, cross-workspace rejection test, orphaning/identity test, reaper-branch tests, guarded-route scope lint, fail-closed static guard test.
- **Build follow-up reclassified** — cosmetic warning, not a failure; do not remove the flag.
