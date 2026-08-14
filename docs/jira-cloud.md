# Jira Cloud Operations

This runbook covers Jira Cloud as the work-management provider and Plain Jira, Xray Cloud, or Zephyr Scale Cloud as the project’s single test-artifact backend. Existing Azure DevOps workspaces keep their PAT-based behavior and do not expose Jira controls.

## Atlassian OAuth Setup

Create an Atlassian OAuth 2.0 (3LO) app for the deployment. Register the exact callback in `ATLASSIAN_OAUTH_REDIRECT_URI`; for example, `https://<deployment>/api/auth/jira/callback`. Configure these classic scopes and no broader scopes:

- `offline_access`
- `read:jira-work`
- `write:jira-work`
- `read:jira-user`
- `manage:jira-webhook`

Set these deployment variables:

- `ATLASSIAN_OAUTH_CLIENT_ID` and `ATLASSIAN_OAUTH_CLIENT_SECRET`: OAuth app credentials.
- `ATLASSIAN_OAUTH_REDIRECT_URI`: exact registered callback URL.
- `ATLASSIAN_ALLOWED_CLOUD_IDS`: comma-separated allowlist of approved Atlassian cloud IDs. An empty allowlist fails closed.
- `ITESTFLOW_PUBLIC_URL`: public HTTPS origin used to build `/api/webhooks/jira`. Jira project onboarding fails if it is absent or not HTTPS.
- `APP_ENCRYPTION_KEY`: base64-encoded 32-byte key used for OAuth and backend secrets.

Restart the web and worker processes after changing deployment variables. Never put real credentials in source control, logs, screenshots, issue comments, or support bundles.

## Connect-to-Disconnect Flow

1. Select **Continue with Jira Cloud** on the login page. OAuth state is bound to the initiating browser with an HttpOnly, SameSite cookie.
2. If the grant contains multiple approved sites, choose one on the browser-bound selection page. Sites outside `ATLASSIAN_ALLOWED_CLOUD_IDS` are rejected.
3. Open **Settings → Connections**. The page shows the connected site and current workspace role without returning tokens.
4. Add a visible Jira project. The server re-reads Jira project access, stores the site-local project identity, and registers the tenant-anchored webhook.
5. Owners or admins configure synchronization direction plus field and status mappings. Members can inspect state and resolve field conflicts but cannot alter shared configuration.
6. Owners or admins select exactly one artifact backend for each Jira project.
7. Use **Synchronization Status**, **Field Conflicts**, and **Traceability Links** to inspect convergence and open remote artifacts.
8. **Disconnect Jira Cloud** requires a second explicit action. It revokes only the signed-in user’s stored connection, clears encrypted token material and sync-principal ownership, and retains shared history for audit and later reconnect.

All controls use native labelled inputs, selects, links, and buttons. The flow is keyboard operable; loading, errors, confirmations, and refreshed sync state use programmatic status or alert regions.

## Artifact Backends

One active backend is stored per workspace project. Switching backend replaces the prior configuration; secret columns are cleared when the new backend does not need them. Each batch item refreshes its caller token before entering the lock, then reads its complete backend snapshot using only the held transaction client and creates its publication claim while holding the same project-scoped PostgreSQL advisory lock used by backend changes. Same-backend credential rotation and cross-backend switching therefore commit before a waiting publisher captures its snapshot, without nested pool acquisition. Remote provider calls occur only after that transaction releases the lock. A backend change is rejected while any artifact publish for that project owns a live publishing claim. The ten-minute lease begins at claim insertion using the PostgreSQL clock; stale comparison, failure retirement, and finalization use that same database time source. Expired claims are retired as errors so an owner can repair credentials or switch backend, and a late publisher cannot activate a retired claim. The next publish of an existing local artifact atomically rebinds its current trace link to the newly selected backend and republishes it there; the prior remote artifact is not deleted.

### Plain Jira

Provide the numeric Jira Test Case issue-type ID and an immutable `customfield_<number>` local-ID field. Publishing searches that field before create and reconciles deterministic remote links and story comments.

### Xray Cloud

Provide the Xray Cloud client ID, client secret, and immutable `customfield_<number>` local-ID field. The client secret is encrypted and never returned. Test IDs are project-scoped before Plan or Execution association; warning-bearing partial operations are recovered by stable-ID lookup and reconciliation.

### Zephyr Scale Cloud

Provide the Zephyr Scale API token, the approved US/EU/AU/DE region, and immutable local-ID field name. The token is encrypted and the region selects a closed endpoint allowlist. Case/Cycle identity scans are bounded, execution publishing uses a fenced durable claim, and request headers plus bodies are subject to a 30-second timeout. Trace links open the Zephyr Scale Test Case view for the remote key rather than a Jira issue view.

## Webhooks and Synchronization

`ITESTFLOW_PUBLIC_URL/api/webhooks/jira` must be reachable from Atlassian over HTTPS. Registration adds a unique server-generated callback key; deliveries are also verified with the configured Atlassian OAuth client secret and resolved by cloud ID plus webhook ID. Invalid or unmatched deliveries return non-retryable 4xx responses; persistence failures return 5xx so Atlassian retries.

The worker claims webhook events and field operations with bounded leases. Two-way reconciliation stores durable per-field baselines, queues pull or push operations before convergence, pauses unresolved conflicts, and advances baselines only after the selected effect succeeds. Transient provider failures are retried with a bounded attempt count; terminal failures remain visible as `error` or `reauthorization_required`.

## Recovery and Diagnostics

- `reauthorization_required`: reconnect from Settings. A terminal OAuth grant failure clears sync-principal ownership and does not keep retrying a known-invalid token.
- `registration_error` or stale registration: retry project onboarding after provider reachability is restored. Recovery reconciles the callback identity before creating another remote webhook.
- `conflict`: choose **Use iTestFlow** or **Use Jira**. The choice queues convergence; the conflict remains visible until the operation completes.
- `error`: inspect the fixed error code and application audit event. Provider response bodies, tokens, client secrets, and API tokens are deliberately excluded.
- missing trace link: retry publishing with the same immutable local artifact ID. Each backend searches or claims that identity before create.
- project not listed: confirm the connected Atlassian user has Browse Projects permission and the site cloud ID is allowlisted.

For non-production verification, run focused Jira unit tests, `npm run typecheck`, `npm run build`, and the full `npm test` suite. Run migration up/down against the disposable `TEST_DATABASE_URL`. A real Atlassian/Xray/Zephyr smoke test requires dedicated non-production tenants and remains a deployment gate; do not point it at production.

## Rollback

Disable scheduled workers and capture a database backup before rollback. Revert the application to the last compatible release, then roll back only migrations introduced after that release using the project migration tooling. Jira migration downgrade deletes OAuth connections, selections, webhook state, sync mappings, backend configuration, and trace links; restore the backup if those records must be retained. Azure DevOps workspace rows and credentials are not converted or deleted by Jira setup.
