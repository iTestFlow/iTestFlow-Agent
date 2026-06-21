# iTestFlow — Multi-User Self-Hosted Migration Plan

**Status:** Phase 0 (Discovery & Design) — approved direction, not yet implemented
**Author:** Solution architecture review
**Target:** Move iTestFlow from single-user/local-first to **privately hosted, workspace-based, multi-user**.
**Decision baseline:** This plan supersedes the original master prompt where they conflict. Conflicts are called out explicitly under [Architectural Decisions](#2-architectural-decisions-adrs). The end-state architecture is unchanged from the original; the **sequencing** is revised to match the real codebase.

> **How to read this document**
> - §1 records what the codebase *actually* is (Phase 0 discovery).
> - §2 records the binding architectural decisions (and where they diverge from the original plan and why).
> - §3 is the target data model and the workspace/project/org mapping.
> - §4 is the revised phase-by-phase plan (1a, 1b, 2, 3, 4, 5) with scope, deliverables, acceptance criteria.
> - §5–§8 are the affected-file inventory, risk register, environment variables, and local dev workflow.
> - §9 is the recommended scope for the **current run**.

---

## 1. Phase 0 — Discovery findings (codebase-aware)

These are verified facts from the current `multi-user-self-hosted` branch, not assumptions.

### 1.1 Database engine

- The DB is **Node's built-in experimental `node:sqlite` (`DatabaseSync`)**, *not* `better-sqlite3`. See [db.ts](../src/modules/shared/infrastructure/database/db.ts#L27). There is **no DB driver in `package.json`** — it's a runtime built-in, which pins the app to **Node ≥ 22.5**.
- Access is a **synchronous** prepared-statement API: `.prepare(sql).all()/.get()/.run()`.
- The full schema (`~50 tables + 2 FTS5 virtual tables`) lives in one file, [schema.sql](../src/modules/shared/infrastructure/database/schema.sql), and is **`exec`'d on every boot** with `CREATE TABLE IF NOT EXISTS` ([db.ts:32](../src/modules/shared/infrastructure/database/db.ts#L32)). **There is no migration system.**
- DB path is `data/itestflow.sqlite` (override `ITESTFLOW_DB_PATH`); tests use `:memory:` + `resetDatabaseForTests()` ([db.ts:42](../src/modules/shared/infrastructure/database/db.ts#L42)).

**Implication:** Moving to `pg` *relaxes* the Node constraint (good), but `pg` is **async** while the entire data layer is **synchronous**. Converting sync→async is the single largest and highest-risk workstream of the whole migration.

### 1.2 Runtime settings & credentials (current single-user model)

- Stored in `data/runtime-settings.json`, AES-256-GCM encrypted; key beside it at `data/.runtime-settings-key`. Layout `iv(12) | tag(16) | ciphertext`, base64. See [runtime-settings.service.ts:249-279](../src/modules/settings/runtime-settings.service.ts#L249).
- Resolved **globally** via `getEffectiveRuntimeSettings()` ([runtime-settings.service.ts:79](../src/modules/settings/runtime-settings.service.ts#L79)) with an **env-variable fallback** `getSettingsFromEnv()` ([runtime-settings.service.ts:165](../src/modules/settings/runtime-settings.service.ts#L165)) reading `AZURE_DEVOPS_PAT`, `OPENAI_API_KEY`, etc.
- Azure DevOps credential resolution: [configured-azure-devops.ts](../src/modules/integrations/azure-devops/configured-azure-devops.ts) (`getConfiguredAzureDevOpsAdapter`, `getProjectScopedAzureDevOpsAdapter`).
- LLM credential resolution: [configured-provider.ts](../src/modules/llm/configured-provider.ts) (`getConfiguredProviderFromEnv`).

**Confirmed:** all hosted users would today share one PAT + one LLM key, and any user could overwrite global settings. This is the core problem the migration solves.

### 1.3 Existing tenancy boundary (this is critical)

The codebase **already has a tenancy boundary**: `ProjectScope` = `{ projectId, azureProjectId, azureProjectName, azureOrganizationUrl }`, defined in [project-isolation.guard.ts](../src/modules/projects/project-isolation.guard.ts) and threaded through nearly every route and service. **Every feature table carries `project_id` + `azure_project_id` + `azure_organization_url`.**

There is **no** user/session/workspace concept. Vestiges of "user": a `local_profile` table and `analytics_workflow_runs.user_id` defaulting to `'local-user'` ([schema.sql:792](../src/modules/shared/infrastructure/database/schema.sql#L792)).

### 1.4 Full-text search (FTS5)

- Two FTS5 virtual tables: `document_chunks_fts` and `project_knowledge_entries_fts` ([schema.sql:222](../src/modules/shared/infrastructure/database/schema.sql#L222), [schema.sql:432](../src/modules/shared/infrastructure/database/schema.sql#L432)).
- All FTS read/index logic is **localized to a single file**, [context-chatbot-retrieval.service.ts](../src/modules/rag/context-chatbot-retrieval.service.ts) (uses `MATCH`, `bm25()`, `@ftsQuery`). This greatly de-risks the FTS→Postgres port.
- An `embeddings` table already stores `vector_json` — pgvector can slot in later with no schema upheaval.

### 1.5 Background scheduling (already in-process)

- [context-auto-update.scheduler.ts](../src/modules/rag/context-auto-update.scheduler.ts) runs a `setInterval` loop **inside the web process**, started by Next.js instrumentation ([instrumentation-node.ts:3](../src/instrumentation-node.ts#L3)).
- Overlap guard is **in-memory per process** (`globalThis`), it reads **global runtime settings**, and it operates on a single configured project scope.

**Implication:** In a multi-replica hosted deploy this loop runs in **every** replica → duplicate syncs; and it **breaks** the moment global settings are removed (Phase 2). Must be neutralized before either happens.

### 1.6 Surface area (blast radii)

| Concern | Count | Location |
|---|---|---|
| Data-access service files (`getDatabase()`/`.prepare`) | **13 files** | analytics, rag (×6), activity-log, audit, llm-request-log, db, health |
| FTS read/index logic | **1 file** | [context-chatbot-retrieval.service.ts](../src/modules/rag/context-chatbot-retrieval.service.ts) |
| API routes total | **~60 routes** | [src/app/api](../src/app/api) |
| Routes resolving credentials (Azure/LLM) | **~30 routes** | Phase 3 blast radius |
| Auth/session/workspace code | **0** | does not exist yet |
| `middleware.ts` | **0** | does not exist |

### 1.7 Already present / reusable

- `.env.example` exists (Azure/LLM vars only) — [.env.example](../.env.example).
- `docs/` folder exists.
- `audit_logs` and `llm_request_logs` tables exist (audit + request logging foundation), plus [sanitize-azure-error.ts](../src/shared/lib/sanitize-azure-error.ts) for redaction.
- Test runner is `vitest`; typecheck is `tsc --noEmit`; no `lint`-blocking config issues observed.

---

## 2. Architectural Decisions (ADRs)

Each decision notes whether it **confirms** or **revises** the original master prompt.

### ADR-1 — Port the existing schema to Postgres *first*, then build auth (REVISES Phase 1)

The original Phase 1 adds only `users/sessions/workspaces/workspace_members` to Postgres while ~50 feature tables stay in `node:sqlite` → a **dual-database window** that violates the prompt's own rule *"no temporary architecture that conflicts with the final target,"* and prevents FKs/joins across the two engines.

**Decision:** Split Phase 1 into:
- **Phase 1a** — behavior-preserving port of the entire schema + data layer to Postgres (no auth, no new features).
- **Phase 1b** — auth/workspace foundation, landing natively on the same Postgres.

This keeps "one database" true at every commit and keeps each PR reviewable.

### ADR-2 — `pg` + a lightweight SQL migration runner; **no ORM** (CONFIRMS "keep it simple")

The data layer is hand-written raw SQL. Adopting Prisma/Drizzle would be a full rewrite and contradicts *"do not rewrite the whole application."*

**Decision:** Use `pg` (node-postgres) + **`node-pg-migrate`** (plain SQL/JS migrations) for `db:migrate`/`db:seed`/`db:reset-dev`. Keep raw SQL in the data layer. Introduce a thin `query()`/`getClient()` wrapper over a singleton `pg.Pool` cached on `globalThis` (survives Next dev HMR). Retire the boot-time `schema.sql` `exec`.

### ADR-3 — Workspace = Azure Org; Project belongs to Workspace (NEW — resolves an ambiguity)

The new `workspace_id` must reconcile with the existing `project_id`/`azure_organization_url` boundary.

**Decision:**
- A **workspace** owns exactly one enabled Azure DevOps organization (`azure_org_url`).
- The existing `projects` table gains a `workspace_id` FK.
- `ProjectScope` is **derived server-side** from `(workspaceId, projectId)`; the client never supplies org/project URLs or PATs.
- Existing single-tenant rows seed-migrate into one bootstrap workspace; `user_id = 'local-user'` rows map to the bootstrap owner.

Because feature tables are already on Postgres after Phase 1a, `workspace_id` is added to *real* tables (not designed around two engines).

### ADR-4 — Stateful opaque sessions; `SESSION_SECRET` is optional HMAC defense-in-depth (CLARIFIES)

The original mixes "opaque session id" (stateful, DB-backed) with `SESSION_SECRET` (implies signing).

**Decision:** Sessions are **stateful**, stored in a `sessions` table; the cookie carries only an opaque, unguessable id. `SESSION_SECRET` is used *only* to HMAC-sign the cookie value as defense-in-depth — not for stateless JWTs. Cookie: `HttpOnly`, `Secure` (prod), `SameSite=Lax`.

### ADR-5 — FTS5→Postgres FTS is coupled to the feature-table port (REVISES a Phase-1 "do-not")

The original says FTS migration is deferrable. It is **not** independently deferrable: porting `document_chunks`/`project_knowledge_entries` to Postgres breaks FTS5 syntax in the one retrieval file.

**Decision:** FTS port happens **inside Phase 1a**, in lockstep with those two tables: replace FTS5 virtual tables with `tsvector` columns + `GIN` indexes, and rewrite the queries in [context-chatbot-retrieval.service.ts](../src/modules/rag/context-chatbot-retrieval.service.ts) (`MATCH`→`@@`, `bm25()`→`ts_rank`). **pgvector stays deferred** (post-MVP), but the retrieval function keeps a single seam so vector/hybrid search can be added later.

### ADR-6 — Neutralize the in-process scheduler early (REVISES — pulls a Phase-4 concern forward)

**Decision:** In Phase 1b, gate the in-process scheduler behind `ENABLE_INPROCESS_SCHEDULER` (default **off** in hosted). It remains the dev convenience until Phase 4's worker supersedes it. This prevents multi-replica double-runs and the Phase-2 global-settings breakage.

### ADR-7 — Gate the env-credential fallback to single-user/dev mode (NEW — closes a re-introduced anti-pattern)

`getSettingsFromEnv()` lets `AZURE_DEVOPS_PAT`/`OPENAI_API_KEY` act as global shared credentials — the exact problem we're removing, via env instead of a file.

**Decision:** Gate `getSettingsFromEnv()` behind `APP_MODE=single-user` (or `ENABLE_ENV_CREDENTIALS`). In hosted multi-user mode it must be **off**, and credential resolution must come only from per-user encrypted storage (Phase 2).

### ADR-8 — Auth is built but not enforced until Phase 2 (CLARIFIES the chicken-and-egg)

The target login (enter PAT → validate → **store encrypted PAT** → create session) requires encrypted credential storage = Phase 2. So Phase 1 cannot ship end-to-end PAT login.

**Decision:** Phase 1b builds session/workspace **primitives** and a **bootstrap/dev session-creation path** (the seeded owner can mint a session without the full PAT-storage flow) so helpers are testable. The app does **not** flip to enforce `requireSession()` across routes until **after Phase 2**. Real PAT-based login lands in Phase 2.

### ADR-9 — Test-DB strategy decided up front (NEW — original defers tests to Phase 5)

`:memory:` + `resetDatabaseForTests()` does not translate to Postgres.

**Decision:** Two tiers — (1) **pure-logic unit tests** stay DB-free; (2) **DB integration tests** run against a disposable Postgres (Docker Compose service `postgres-test`, or Testcontainers), with each test wrapped in a transaction rolled back at teardown. This is set up in Phase 1a so the port lands tested.

### ADR-10 — Keep an auth-provider seam for future SSO (NEW — design-for-future)

PAT-as-login is a pragmatic v1 but couples login to a per-user secret and to ADO availability.

**Decision:** Key `users` on `azure_identity_id`/`descriptor` (not the PAT), and put PAT validation behind an `AuthProvider` interface so Entra ID / OAuth SSO can be added later without reworking tables.

---

## 3. Target data model

### 3.1 Identity / access tables (new)

```
users               (id, display_name, email_or_unique_name, azure_identity_id,
                     azure_descriptor, status, created_at, last_login_at)
sessions            (id, user_id, hashed_token, ip, user_agent, created_at,
                     last_seen_at, expires_at, revoked_at)
workspaces          (id, name, azure_org_name, azure_org_url, status,
                     created_at, updated_at)
workspace_members   (id, workspace_id, user_id, role['owner'|'admin'|'member'],
                     status, created_at, updated_at)
```

### 3.2 Credential / settings tables (Phase 2)

```
user_credentials    (id, workspace_id, user_id, credential_type['azure_pat'|'llm_api_key'],
                     provider, encrypted_secret, encryption_iv, encryption_tag,
                     masked_preview, status, last_validated_at, created_at, updated_at)
user_llm_settings   (id, workspace_id, user_id, provider, model, temperature,
                     max_output_tokens, is_default, created_at, updated_at)
workspace_credentials (id, workspace_id, credential_type='azure_pat', provider,
                     encrypted_secret, encryption_iv, encryption_tag, masked_preview,
                     created_by_user_id, last_validated_at, status, created_at, updated_at)
```

### 3.3 Worker / audit tables (Phase 4 / progressive)

```
jobs                (id, workspace_id, job_type, payload_json, status, priority,
                     attempts, max_attempts, locked_by, locked_at, run_after,
                     started_at, finished_at, error_message, created_by_user_id,
                     created_at, updated_at)
activity_logs       (id, workspace_id, actor_user_id, action, entity_type, entity_id,
                     summary, metadata_json, created_at)
-- `audit_logs` and `azure_devops_sync_runs` already exist and are extended with workspace_id.
```

### 3.4 Existing tables (~50) — ported in Phase 1a, gain `workspace_id` in Phase 3

All current feature tables are ported verbatim to Postgres in Phase 1a (types adjusted: `TEXT`→`text`, `INTEGER`→`integer`/`boolean`, FTS5→`tsvector`). In Phase 3 they gain `workspace_id` (FK → `workspaces`) and actor columns (`created_by_user_id`, `triggered_by_user_id`, `published_by_user_id`, etc.).

### 3.5 Mapping rule (ADR-3)

```
workspace (1) ── owns ──> (1) Azure DevOps org   [azure_org_url]
workspace (1) ── has ───> (N) projects           [projects.workspace_id]
ProjectScope = derive(workspaceId, projectId)    -- server-side only, never from client
```

---

## 4. Revised phase plan

### Phase 1a — Postgres port (behavior-preserving)  ◀ start here

**Goal:** Same features, same behavior, on Postgres instead of `node:sqlite`. No auth, no workspace columns, no UI changes.

**Scope**
- Add deps: `pg`, `node-pg-migrate`. Scripts: `db:migrate`, `db:migrate:down`, `db:seed`, `db:reset-dev`.
- `docker-compose.yml` with a `postgres` service (+ optional `pgadmin`, `postgres-test` profiles). Docker **not** mandatory for the web app (ADR-2, original requirement).
- Port [schema.sql](../src/modules/shared/infrastructure/database/schema.sql) → initial migration(s). FTS5 tables → `tsvector` columns + `GIN` indexes (ADR-5).
- Replace [db.ts](../src/modules/shared/infrastructure/database/db.ts) with a `pg.Pool` singleton + `query()`/`getClient()` wrapper; remove boot-time schema `exec`.
- Convert the **13 data-access service files** from sync to `async`; thread `await` to their callers (mostly already-async routes).
- Rewrite FTS read/index in [context-chatbot-retrieval.service.ts](../src/modules/rag/context-chatbot-retrieval.service.ts): `MATCH`→`@@ websearch_to_tsquery`, `bm25()`→`ts_rank_cd`.
- Update [health route](../src/app/api/health/route.ts) to probe Postgres.
- Test harness per ADR-9 (`postgres-test` + transactional fixtures).

**Acceptance criteria**
- `docker compose up -d postgres && npm run db:migrate && npm run dev` boots cleanly.
- All existing features behave identically against Postgres.
- Knowledge Hub search returns results via Postgres FTS.
- `npm run test`, `npm run typecheck`, `npm run build` pass.
- No `node:sqlite` references remain in runtime paths.

### Phase 1b — Session, workspace & role foundation

**Goal:** Identity primitives on the same Postgres.

**Scope**
- Migrations: `users`, `sessions`, `workspaces`, `workspace_members` (§3.1). Add `workspace_id` to `projects`.
- Helpers: `requireSession()`, `getOptionalSession()`, `requireWorkspaceAccess(userId, workspaceId)`, `requireWorkspaceRole(userId, workspaceId, roles[])`.
- `AuthProvider` seam (ADR-10) with a `PatAuthProvider` stub (validation wired fully in Phase 2).
- Bootstrap: idempotent seed of owner user + workspace from `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_AZURE_ORG`; map legacy `local-user` rows to the owner.
- Dev/bootstrap session-creation path (ADR-8) so helpers are exercisable.
- Neutralize in-process scheduler behind `ENABLE_INPROCESS_SCHEDULER` (ADR-6).
- Extend `.env.example` (§7). Cookie/session config per ADR-4.

**Acceptance criteria**
- Migrations create all four tables + the `projects.workspace_id` column.
- A bootstrapped owner exists; a dev session can be minted and resolved by `requireSession()`.
- `requireWorkspaceAccess`/`requireWorkspaceRole` enforce membership/role in unit tests.
- No secrets in cookies. App still builds; existing routes not yet rewritten.
- Scheduler does not start when `ENABLE_INPROCESS_SCHEDULER` is unset.

### Phase 2 — Credentials & runtime-settings migration

**Goal:** Replace global filesystem settings with per-user/workspace encrypted credentials; ship real PAT login.

**Scope:** `user_credentials`, `user_llm_settings`, `workspace_credentials` (§3.2). `EncryptionService` keyed by `APP_ENCRYPTION_KEY` (AES-256-GCM, unique IV per secret, key outside DB & data dir; rotation-ready). Per-user Azure PAT + LLM key storage, masking, validation. Real PAT login flow (validate against ADO → read identity → upsert user → store encrypted PAT → create session). Replace `getEffectiveRuntimeSettings()` reads with scoped resolution. Deprecate `data/runtime-settings.json` + `.runtime-settings-key`; gate env fallback (ADR-7). My-Credentials Settings UI (status/masked preview only). Ensure no raw secrets returned/logged (audit `llm_request_logs` payloads).

**Acceptance:** each user has a private PAT + LLM key; no cross-user read/overwrite; no raw secrets to frontend; filesystem settings no longer source of truth; features resolve creds via the scoped service.

### Phase 3 — Workspace-scoped feature refactor

**Goal:** Every feature uses authenticated user + workspace-scoped shared data.

**Scope:** Add `workspace_id` (+ actor columns) to the ~50 feature tables; backfill to bootstrap workspace. Refactor the **~30 credential-resolving routes** to the pattern: `requireSession()` → `requireWorkspaceAccess()` → derive `ProjectScope` from `(workspaceId, projectId)` → resolve **current user's** credential for interactive actions. Client sends only `workspaceId/projectId/workItemId/payload` — never org/project URL, PAT, or credential id. Shared records store `workspace_id`; triggered/published records store actor user id.

**Acceptance:** no feature relies on global settings; no client-supplied Azure scope/creds trusted; shared data workspace-scoped; history shows actor; same-workspace users see shared dashboards/history/knowledge; private creds stay private.

### Phase 4 — Background worker & job queue

**Goal:** Dedicated worker for scheduled/long-running tasks.

**Scope:** `jobs` table (§3.3); standalone `worker` process (`npm run worker` / `worker:dev`); polling runner using `SELECT ... FOR UPDATE SKIP LOCKED`; retry/backoff/failure handling. Move scheduled sync + knowledge indexing off the in-process scheduler to the worker, using the **workspace sync credential** (not a user PAT). Interactive actions keep using the current user's credential.

**Acceptance:** web and worker run separately; jobs persisted; two workers never double-process; scheduled sync runs with no logged-in user; sync uses workspace credential; job status/failures visible.

### Phase 5 — Hardening, cleanup & docs

**Scope:** Remove dead SQLite/filesystem-settings paths; improve audit logging + role-management UI; credential expiry warnings; login + validation rate limiting; deployment/backup/restore docs; production checklist; redaction tests; authorization tests; DB integration tests.

**Acceptance:** no active SQLite/filesystem-settings dependency; clear deploy/dev/bootstrap docs; clear credential + shared-vs-private behavior; tests/typecheck/build pass.

---

## 5. Affected-file inventory (Phase 1a/1b focus)

**Replace / heavily change**
- [src/modules/shared/infrastructure/database/db.ts](../src/modules/shared/infrastructure/database/db.ts) — `pg.Pool` wrapper, drop `node:sqlite` + boot-exec.
- [src/modules/shared/infrastructure/database/schema.sql](../src/modules/shared/infrastructure/database/schema.sql) → migrations under `migrations/`.
- [src/modules/rag/context-chatbot-retrieval.service.ts](../src/modules/rag/context-chatbot-retrieval.service.ts) — FTS rewrite.

**Sync→async conversion (13 data-access files)**
- analytics: `workflow-analytics.service.ts`, `system-dashboard.service.ts`
- rag: `context-chatbot-retrieval.service.ts`, `project-knowledge.service.ts`, `project-knowledge-compiled.service.ts`, `project-context-store.service.ts`, `context-auto-update-run-history.service.ts`, `project-context-schema.service.ts`
- `activity-log.service.ts`, `audit.service.ts`, `llm/llm-request-log.service.ts`, `health/route.ts`, `db.ts`
- …plus transitive callers gaining `await`.

**Phase 1b additions (new files)**
- `src/modules/auth/{session.service.ts, auth-provider.ts, pat-auth-provider.ts}`
- `src/modules/workspace/{workspace.service.ts, workspace-access.guard.ts}`
- `src/modules/bootstrap/bootstrap-owner.ts`
- migrations for identity tables; `.env.example` update.

**Scheduler**
- [src/modules/rag/context-auto-update.scheduler.ts](../src/modules/rag/context-auto-update.scheduler.ts) + [src/instrumentation-node.ts](../src/instrumentation-node.ts) — env gate.

**Phase 3 (later) — ~30 credential-resolving routes** under [src/app/api](../src/app/api) (azure-devops/*, bugs/*, test-cases/*, requirement-analysis/*, test-execution-effort/*, context/*, publish/*, test-suite-migration/*, dashboard/*, settings/*).

---

## 6. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Sync→async conversion misses a caller → runtime breakage | High | Convert per-module with tests; `tsc` catches most; integration tests per ADR-9 |
| R2 | FTS semantics differ (ranking/tokenization) vs FTS5 | Medium | Localized to 1 file; snapshot-compare results on a fixture corpus |
| R3 | Dual-DB smell if 1a is skipped | High | ADR-1 port-first eliminates it |
| R4 | In-process scheduler double-runs / breaks | Medium | ADR-6 env gate in 1b |
| R5 | Env-cred fallback re-introduces shared creds | High | ADR-7 mode gate |
| R6 | Auth primitives unusable/untestable in Phase 1 | Medium | ADR-8 bootstrap/dev session path |
| R7 | `pg.Pool` exhaustion under Next dev HMR | Medium | `globalThis` singleton pool |
| R8 | Secret leakage via `llm_request_logs` payloads | Medium | Redaction audit in Phase 2; reuse `sanitize-azure-error.ts` |
| R9 | Encryption key rotation later | Low | Store `key_version` alongside ciphertext (Phase 2 schema) |

---

## 7. Environment variables

**Existing** ([.env.example](../.env.example)): `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PAT`, `DEFAULT_LLM_PROVIDER`, `NEXT_PUBLIC_LLM_PROVIDER_LABEL`, `OPENAI_*`, `GEMINI_*`, `ANTHROPIC_*`, `LLM_MAX_OUTPUT_TOKEN_CAP`, `LLM_RETRY_ATTEMPTS`, `PROJECT_CONTEXT_TOP_K`.
→ In hosted mode the Azure/LLM credential vars become **single-user/dev-only** and are gated off (ADR-7).

**New (server-side; not editable from UI)**

| Var | Phase | Purpose |
|---|---|---|
| `DATABASE_URL` | 1a | Postgres connection string |
| `APP_MODE` (`single-user`\|`hosted`) | 1b | Gates env-cred fallback (ADR-7) |
| `ENABLE_INPROCESS_SCHEDULER` | 1b | Dev-only scheduler toggle (ADR-6) |
| `SESSION_SECRET` | 1b | Optional cookie HMAC (ADR-4) |
| `BOOTSTRAP_OWNER_EMAIL` | 1b | Initial owner identity |
| `BOOTSTRAP_OWNER_AZURE_ORG` | 1b | Initial allowed Azure org |
| `APP_ENCRYPTION_KEY` | 2 (placeholder doc'd in 1b) | Encrypt/decrypt stored secrets |

---

## 8. Local developer workflow (target)

```bash
docker compose up -d postgres     # Postgres only; Docker not required for the app
npm run db:migrate                # apply migrations
npm run db:seed                   # bootstrap owner/workspace (1b+)
npm run dev                       # Next.js web app
# npm run worker:dev              # Phase 4+
```
Developers may skip Docker and point `DATABASE_URL` at a native Postgres. An optional full Compose profile (web+worker+postgres) is provided but not mandatory.

---

## 9. Recommended scope for the current run

**Phase 0 (this document) + Phase 1a (Postgres port).** Reason: Phase 1a is the dominant, highest-risk workstream (sync→async + FTS). Bundling 1a + 1b + Phase 0 into one change would be too large to review safely (R1). Land 1a green (tests/typecheck/build), then take **Phase 1b** as the next run.

**Explicitly not in this run:** Phase 1b auth tables/helpers, Phase 2 credentials, Phase 3 scoping, Phase 4 worker, Phase 5 hardening, any UI redesign.

**End-of-run report will include:** summary, files changed, new migrations/tables, new env vars, how to run locally, compatibility notes, known risks, Phase 1b TODOs, and typecheck/test/build results.
