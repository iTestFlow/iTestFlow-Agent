# Findings traceability matrix — test-execution branch fix pass

Source: adversarial code review (54 confirmed / 7 refuted). Completion gate: every row
must end `fixed+tested` or `re-reviewed-N/A (justification recorded)`.

## Reported findings (structured report, 32)

| # | ID | File | Finding | Plan item | Test | Status |
|---|----|------|---------|-----------|------|--------|
| 1 | V2-1 | mysql-database-executor.ts | MySQL slow query hangs worker; timeout doesn't cancel | C1 | mysql executor tests (KILL via pinned control conn; cancel-failure → destroy) | fixed+tested |
| 2 | V6-4 | report-assembler.ts | Run detail serves raw DB/API rows to any member | A5 (+A1) | report-assembler test + sensitive-data.test | fixed+tested |
| 3 | V6-1 | multi-layer-step-executor.ts | Persisted action captures bypass the secret scrubber | A2 | multi-layer test ("learns sensitive captures…") | fixed+tested |
| 4 | V5-1 | egress-policy.service.ts | SSRF: NAT64/6to4 IPv6 bypass the private-net gate | E1 | egress-policy.transitional.test (31 cases) | fixed+tested |
| 5 | V3-1 | sql-policy.ts | Non-scalar SQL params silently rewrite query | C5 | sql-policy.test scalar gate | fixed+tested |
| 6 | V7-1 | runs/route.ts | Reviewed-env version guard checks POST, not review | F1 | runs/route.test (client token frozen; missing token → 400) | fixed+tested |
| 7 | V1-1 | multi-layer-step-executor.ts | 2nd identical UI action hard-fails as blocked_policy | B1 (+B4) | multi-layer test (repeat allowed; no-progress guard) | fixed+tested |
| 8 | V1-3 | multi-layer-step-executor.ts | First runtime policy rejection is terminal, no retry | B3 | multi-layer test (repeated identical policy block → blocked_policy) | fixed+tested |
| 9 | V4-6 | test-execution-layer-runtime.ts | Failed SQL mapped to status 'ok', counts as evidence | D3 | pinned by comment + existing runtime test (23505 case) — intended agent-feedback semantics | re-reviewed: intended (pinned) |
| 10 | V2-2 | mysql-database-executor.ts | Dead DB connection cached, poisons rest of run | C2 | executor tests ×3 (resetConnection on transport/cancel) | fixed+tested |
| 11 | V2-3 | mysql-database-executor.ts | inspectSchema outside try → whole-step infra error | C3 | executor suites (schema error → query_error/transport) | fixed+tested |
| 12 | V2-6 | database-result.ts | db_select buffers full result set before row cap | C4 | sql-policy.test AST bounding (inject/preserve/clamp/reject) | fixed+tested |
| 13 | V6-2 | test-execution-layer-runtime.ts | Captures read raw body, bypass key-redaction | A6 (+A3) | capture-store provenance+value-alias; raw body never persisted | fixed+tested |
| 14 | V6-3 | case-capture-store.ts | minimumLength:1 scrub poisons output, breaks JSON | A4 | sensitive-data.test two-tier redaction | fixed+tested |
| 15 | V4-7 | test-execution-layer-runtime.ts | Template render throws outside try → false uncertain | D1 | executeApi/executeDatabase builder-guard (blockedFromRenderError) | fixed |
| 16 | V4-8 | test-execution-layer-runtime.ts | Unguarded takeSnapshot failure → false uncertain | D2 | snapshot retry-then-null, never stale | fixed |
| 17 | V1-4 | multi-layer-step-executor.ts | Placeholders unsubstituted in api path / db sql | B5 | resolveAction path substitution; SQL placeholders → bind params | fixed |
| 18 | V1-5 | multi-layer-step-executor.ts | Non-string capture into UI fill/nav breaks action | B5 | resolvedText scalar coercion + friendly reject | fixed |
| 19 | V7-2 | test-execution-run.handler.ts | Login-plan run reclaim kills all remaining cases | F2 | reclaim guard moved inside loginNeeded (verified session continues) | fixed |
| 20 | V7-3 | agentic-step-executor.ts | v2 prompt offers actions the login validator rejects | I1 | login-mode tests (unified engine; api/db rejected) | fixed+tested |
| 21 | V3-2 | sql-policy.ts | Param regex matches inside SQL string literals | C6 | sql-policy.test literal-aware scanning + compile | fixed+tested |
| 22 | V3-3 | integration-capabilities.service.ts | Authoring SQL check weaker than runtime; dead ops | C7 | validateSqlTemplate == runtime validator | fixed |
| 23 | V4-1 | guarded-api-executor.ts | Out-of-base API path silently re-rooted under base | F5 | canonicalize-then-validate; prefix-collision reject; traversal decode | fixed |
| 24 | V4-5 | runs/route.ts | OpenAPI discovery reuses tiny per-request timeout | F6 | runs/route.test (30s floor asserted) | fixed+tested |
| 25 | V8-2 | environment-profile.service.ts | No server-side secret/config cross-validation | F4 | connectionSecretIssue on create+update → 400 | fixed |
| 26 | V8-1 | environment-profile.service.ts | Legacy profile fails re-parse on any patch → 500 | F3 | ZodError → 400 in toFriendlyErrorResponse | fixed |
| 27 | V9-1 | integration-capabilities-panel.tsx | Capabilities fetch race shows wrong scope's ops | G1 | AbortController + abort-on-scope-change | fixed |
| 28 | V11-1 | integration-capabilities.service.ts | Forbidden-header security regex duplicated verbatim | H1 | shared isForbiddenRequestHeader (sensitive-data.ts) | fixed+tested |
| 29 | V11-5 | run.service.ts | Layer availability derived 4 ways, 3 definitions | H3 | environment-layers.ts single source (run.service + runtime) | fixed |
| 30 | V10-5 | run.service.ts | Run-detail poll re-ships full growing JSONB payload | I2 | change_seq cursor + delta endpoint + run-polling.test merge suite | fixed+tested |
| 31 | V11-2 | openapi-contract.service.ts | Canonical-JSON hashing duplicated 4x, key-order drift | H2 | shared canonical-json.ts (snapshot/openapi/executor) | fixed |
| 32 | V9-5 | test-execution-client.tsx | uiEnabled field-blanking + payload duplicated 4x | G2 | buildOneTimeEnvironmentSubmission single copy | fixed |

## Overflow findings (prose, 22)

| # | ID | Finding | Plan item | Status |
|---|----|---------|-----------|--------|
| 33 | V10-1 | Transactional execute() state machine triplicated across 3 DB executors | Low batch | fixed (shared rollback/cancel/queryError helpers in database-executor.shared.ts; remaining per-driver flow is genuinely driver-specific) |
| 34 | V10-2 | runMultiLayerStep re-implements runAgenticStep loop | I1 | fixed+tested (agentic-step-executor deleted; login = mode of one engine) |
| 35 | V10-3 | Two run-finalizer UPDATEs duplicate mutation→uncertain CASE | Low batch | fixed (finalizeInFlightActions) |
| 36 | V6-5 | Six drifting sensitive-key redaction copies, 3 markers | A1 | fixed+tested (sensitive-data.ts, anchored matching) |
| 37 | V5-2 | Host-normalization triplicated in egress path | Low batch | fixed (normalizeEgressHostname shared; pinned-http keeps URL-level handling by design) |
| 38 | V7-4 | metadata_only retention nulls errorDetails; LLM audit blind on failed rows | Low batch | fixed (bounded first-line excerpt retained) |
| 39 | V2-5 | Unescaped LIKE metachars in schema inspection | Low batch | fixed (escapeLikePattern ×3 drivers, mssql ESCAPE clause) |
| 40 | V8-1b | ZodError→500 instead of 400 on inconsistent PATCH | F3 | fixed (shared mapping) |
| 41 | V5-3 | Per-hop egress-rule re-SELECT with no cache | Low batch | fixed (2s TTL cache, write-invalidated) |
| 42 | V6-6 | Scrubber regex recompiled per call | Low batch | fixed (patterns precompiled per value set) |
| 43 | V6-7/8 | Scrub values re-derived per action | Low batch | fixed (addScrubValues refresh only when the value set grows; derive stays per-action by design — captures are bounded at 32) |
| 44 | V10-6 | Capability manifest re-ranked every loop iteration | Low batch | fixed (ranked once per step) |
| 45 | V10-4 | RunExecutionBundle.secretPurposes built with zero readers | Low batch | fixed (removed) |
| 46 | V4-4 | Dead assertApiTarget callback seam | Low batch | fixed (dead handler callbacks removed; options remain documented test-only seams) |
| 47 | V4-3 | agent:false disabling pooling (deliberate) | Low batch | fixed (documented as an intentional per-hop pinning guarantee) |
| 48 | V11-3 | Relative-path validator ×3 | Low batch | re-reviewed N/A: the three checks enforce deliberately different strictness (agent read-path shape vs stored-operation safety vs OpenAPI import); unifying would weaken at least one boundary |
| 49 | V11-4 | Postgres 23505 check ×4 | Low batch | fixed (isPgUniqueViolation in db.ts, adopted ×4) |
| 50 | V8-3 | Connection-secret name list ×5 | Low batch | fixed (client derives from canonical schema list) |
| 51 | V8-4 | Operation-schema ×3 | Low batch | re-reviewed N/A: the copies are zod (API), ajv-JSON-schema (pinned capability), and client normalization — different validation engines by design; a shared literal would still need per-engine adapters |
| 52 | V8-5p | requireEgressAdmin dup | Low batch | fixed (egress-admin.ts shared) |
| 53 | V9-4 | Review-step layer-hint drift | Low batch | fixed (results-step inline union → LayerHint import; other sites already imported TEST_EXECUTION_LAYER_HINTS) |
| 54 | V9-6 | Client capability type/mapping dup, dead snake_case fallbacks | Low batch | re-reviewed N/A: the snake_case fallbacks are pinned by the module's own tests as accepted legacy-input tolerance; removal is churn with no behavior gain |

## Hardening beyond confirmed findings (not counted in the 54)

| ID | Item | Plan item | Status |
|----|------|-----------|--------|
| H-Teredo | Decode Teredo 2001::/32 embedded IPv4 | E1 (extra) | fixed+tested |
| H-B2-reset | Replay strikes reset only on effectful observed progress (reads never launder) | B2 | fixed+tested |
| H-B3-code | Stable policy codes on executor errors feed policy-wall fingerprints | B3 | fixed |

## Refuted — out of scope (7)

V4-2 (accept-encoding gzip), V2-4 (bigint TypeError), V9-2 (NaN clamp), V9-3 (evidence never renders), V7-6 (cross-tenant run leak), V1-6 (layer misattribution), V8-5 port-range half.
