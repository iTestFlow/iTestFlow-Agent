# Jira Cloud Operations

This runbook covers Jira Cloud as the work-management provider and Plain Jira, Xray Cloud, or Zephyr Scale Cloud as the project's single test-artifact backend. Existing Azure DevOps workspaces keep their PAT-based behavior and do not expose Jira controls.

## Atlassian API Token Setup

Jira sign-in mirrors the Azure PAT flow: each user signs in with their Atlassian account email and a personal API token created at `https://id.atlassian.com/manage-profile/security/api-tokens`. No OAuth app registration, callback URL, webhook ingress, or public HTTPS origin is required for token sign-in — the deployment only makes outbound calls to Atlassian, which suits local and private self-hosted installations. Atlassian OAuth is an optional second sign-in method; see **Atlassian OAuth Sign-In** below.

Both Atlassian API token kinds work, and the kind is detected automatically at sign-in:

- **API tokens with scopes** (recommended by Atlassian): create the token with the `read:jira-work`, `write:jira-work`, and `read:jira-user` scopes. Scoped tokens are validated and used through the `api.atlassian.com` gateway.
- **Classic tokens without scopes**: carry the full permissions of the Atlassian account and are validated and used against the site URL directly. Atlassian has announced their deprecation in favor of scoped tokens.

A token missing required scopes is reported distinctly from a wrong email/token pair, so a mis-scoped token is never diagnosed as a bad password. Atlassian caps every API token at a one-year lifetime; when a token expires or is revoked, the first rejected request marks the stored connection invalid. When API-token connections are enabled, the user can replace the token in **Settings → Connections**; in OAuth-only mode, the sync owner instead reconnects with Atlassian — scheduled sync resumes in place, with no principal handover.

Settings accepts replacement tokens only for Jira account IDs already linked to the signed-in iTestFlow user. Users without a linked Jira identity must first sign in through the Jira login flow. Matching email addresses alone do not authorize a Settings connection; a rejected replacement leaves the current credential and sync principal unchanged.

Set these deployment variables:

- `APP_ENCRYPTION_KEY`: base64-encoded 32-byte key used for API-token and backend secrets.
- `BOOTSTRAP_JIRA_SITES` (and optionally the legacy pair below): the configured-site trust boundary described next.

Restart the web and worker processes after changing deployment variables. Never put real credentials in source control, logs, screenshots, issue comments, or support bundles.

Reverse-proxy note: the login routes reject provably cross-origin submissions by comparing the browser `Origin` header to the request `Host`. A proxy that rewrites `Host` without forwarding the public host will 403 every browser login — forward the original host header. Also set `RATE_LIMIT_TRUSTED_PROXY_HOPS` to the real proxy depth so login throttling reads the correct client IP.

### Bootstrap and Provider Enablement

A fresh Jira Cloud deployment must configure `BOOTSTRAP_JIRA_SITES` with an owner email before Jira sign-in works. The login page accepts only configured active sites; it never lets the first visitor create and own an arbitrary site, and the sign-in route rejects unconfigured sites before any credential leaves the server. Bootstrap configuration is optional only for an upgrade whose database already carries an active jira-cloud workspace from an earlier seed.

- `BOOTSTRAP_OWNER_JIRA_SITE` + `BOOTSTRAP_OWNER_EMAIL`: legacy single-site compatibility pair, seeded only when both are set. Prefer `BOOTSTRAP_JIRA_SITES` for new deployments.
- `BOOTSTRAP_JIRA_SITES`: comma-separated `siteUrl|ownerEmail` entries (a site accepts `mysite`, `mysite.atlassian.net`, or `https://mysite.atlassian.net`; omit `|email` to inherit `BOOTSTRAP_OWNER_EMAIL`). Each entry seeds the site's workspace, its owner user, and the owner membership at startup, so the site appears in the login page's site picker and its declared owner — not the first visitor — owns the workspace.
- `BOOTSTRAP_ENABLED_PROVIDERS`: which sign-in providers the login page offers (`azure-devops`, `jira-cloud`, comma-separated, first entry is the default pane). Unset auto-detects: Azure DevOps always, Jira Cloud when a bootstrap site resolves or the database already has an active jira-cloud workspace. Explicitly enabling `jira-cloud` with no configured site refuses to start.

Operational notes:

- The owner email must match the owner's Atlassian account email (case-insensitive) — it is literally the email that owner types at sign-in — so the seeded user reconciles in place on their first token login with no duplicate user or identity.
- A seeded site's stable Atlassian cloud ID is resolved from the site's public tenant endpoint and pinned on the first successful sign-in, which "adopts" the seeded workspace row. Later sign-ins are verified against the pinned cloud ID, so a freed URL re-registered as a different Atlassian site fails closed.
- Jira synchronization waits until a declared owner signs in: the first owner's connection becomes the workspace sync principal (`account_id` from Jira's `accountId` field is stored as `provider_subject`), so the declared owner should sign in before members rely on sync.
- Bootstrap is additive and never flips a disabled site back to active. In a multi-instance deployment, let one instance finish startup seeding before serving logins so every site picker reads the completed configuration.

### Renaming a Jira Site URL

1. Confirm that Atlassian reports the same cloud ID for the renamed site and that no different cloud-ID-backed workspace already owns the new URL.
2. Update `BOOTSTRAP_JIRA_SITES` to the new URL before restarting the application; remove the old URL entry and keep the intended owner email.
3. Restart the application so bootstrap seeds the new URL placeholder.
4. Have an authorized user sign in through the new site-picker entry. The next successful sign-in reconciles the placeholder into the existing cloud-ID-backed workspace, preserves the existing workspace identity and data, transfers the placeholder owner membership, retires the placeholder, and refreshes the stored site name and URL.
5. Confirm that only the existing cloud-ID-backed workspace is active at the new URL. A conflicting cloud ID, inactive candidate, ambiguous candidate set, or malformed placeholder fails closed and requires operator investigation.

Until the operator completes this procedure, sign-ins against the old URL fail closed — the stale window is operator-owned, which is the deliberate trade for having no OAuth-discovered rename detection.

## Atlassian OAuth Sign-In

Atlassian OAuth 2.0 (3LO) is an optional second sign-in method beside API tokens — the path for organizations whose Atlassian authentication policy blocks API tokens. It is inert until configured: with none of the variables below set, a deployment behaves exactly as the token-only era.

1. Register an app in the Atlassian developer console (`https://developer.atlassian.com/console/myapps`) with the callback URL `https://<your-host>/api/auth/jira/callback` and grant it the `offline_access`, `read:me`, `read:jira-work`, `write:jira-work`, and `read:jira-user` scopes.
2. Set all three variables or none. A callback URL alone, with both client credentials absent, is ignored for compatibility with older Azure-only templates. Once either client credential is supplied, a partial set refuses to start the web and worker processes. Explicit OAuth sign-in still requires the complete set:
   - `ATLASSIAN_OAUTH_CLIENT_ID=<from the developer console>`
   - `ATLASSIAN_OAUTH_CLIENT_SECRET=<from the developer console>`
   - `ATLASSIAN_OAUTH_REDIRECT_URI=<the exact registered callback URL>`
3. Optionally set `JIRA_LOGIN_METHODS` to control what the login page offers: unset keeps the API token form as the default and adds a **Continue with Atlassian** action once the client is configured; `JIRA_LOGIN_METHODS=oauth` is the OAuth-only mode that removes token sign-in from the deployment entirely (the token login route refuses before parsing anything).

`JIRA_LOGIN_METHODS` controls new sign-in and Settings connections only; it does not revoke stored API tokens or PATs. In OAuth-only mode, background sync continues using a healthy stored API token or PAT for the designated sync owner. An OAuth sign-in overwrites the credential row for the same user under latest-wins behavior. Once rejected at use time, the credential becomes invalid and the sync owner recovers with **Reconnect with Atlassian**. Token-specific validation guidance remains intentionally unchanged because only token sign-in and enabled token-connection flows can reach it.

On a transient method-resolution failure, the empty method set suppresses only the advisory stale warning. The advisory warning self-heals on the next successful status read; authentication, authorization, invalid-state reporting, and reauthorization reporting are unaffected.

The redirect URI only needs to be reachable by the user's browser — `http://localhost:3000/api/auth/jira/callback` works for local development; no public inbound origin is required.

OAuth sign-in starts from the same configured-site trust boundary as token sign-in: the user picks a `BOOTSTRAP_JIRA_SITES` site, approves access on Atlassian, and the callback verifies the grant covers exactly that site before provisioning — it never silently switches to another site the account can access. The latest successful sign-in with either method becomes the user's single stored credential.

Operational notes:

- Atlassian rotates the refresh token on every refresh and expires an unused one after 90 days; background sync keeps its own grant fresh while scheduled sync is enabled and has work to run, but an idle user's — or an idle workspace's — connection can lapse. Atlassian tolerates the immediately previous refresh token for a 10-minute leeway window, which also covers a crash between a refresh and its persistence. (Both figures are from Atlassian's OAuth 2.0 (3LO) documentation; re-verify them there when planning retention policies.)
- A dead grant — password change, app access revoked, or an expired refresh token — flips the connection to **Reconnect needed**. Recovery is **Reconnect with Atlassian** in **Settings → Connections**: a fresh consent restores scheduled sync in place, with no principal handover. Scheduled runs blocked this way carry the job code `jira_sync_principal_reauthorization_required`.
- A rotated app client secret or an Atlassian outage is transient: connections are never terminally flipped by them. Fix the configuration and the next request recovers on its own.

## Connect-to-Disconnect Flow

1. Select **Jira Cloud** on the login page, pick the Jira site (a single configured site is selected automatically), and sign in with your Atlassian account email and API token — or, when OAuth is enabled, with **Continue with Atlassian**. Tokens are validated against Atlassian before anything is stored; only an opaque session cookie reaches the browser. Sign-in failures are announced inline and distinguish an invalid email/token pair, a token missing scopes, an unconfigured site, an inaccessible site on an OAuth grant, and an Atlassian outage — without echoing the token or unlisted site names.
2. Open **Settings → Connections**. The page shows the connected site, current workspace role, the sign-in method, and the connection's lifecycle state (Connected, Invalid token, Reconnect needed, Not connected) without returning tokens. **Replace API token** stores a new token in place after re-validating the site's pinned cloud ID; **Reconnect with Atlassian** renews an OAuth grant the same way.
3. Add a visible Jira project. The server re-reads Jira project access and stores the site-local project identity — no webhook or public URL is involved.
4. Owners or admins configure synchronization direction plus field and status mappings. Members can inspect state and resolve field conflicts but cannot alter shared configuration.
5. Owners or admins select exactly one artifact backend for each Jira project.
6. Use **Synchronization Status**, **Field Conflicts**, and **Traceability Links** to inspect convergence and open remote artifacts.
7. **Disconnect Jira Cloud** requires a second explicit action. It revokes only the signed-in user's stored connection, genuinely clears the encrypted token columns and sync-principal ownership, and retains shared history for audit and later reconnect. Connection replacement and revocation are audited (`JIRA_CONNECTION_REPLACED`, `JIRA_CONNECTION_REVOKED`).

All controls use native labelled inputs, selects, links, and buttons. The flow is keyboard operable; loading, errors, confirmations, and refreshed sync state use programmatic status or alert regions.

## Artifact Backends

One active backend is stored per workspace project. Switching backend replaces the prior configuration; secret columns are cleared when the new backend does not need them. Each batch item resolves the caller's stored API token before entering the lock, then reads its complete backend snapshot using only the held transaction client and creates its publication claim while holding the same project-scoped PostgreSQL advisory lock used by backend changes. Same-backend credential rotation and cross-backend switching therefore commit before a waiting publisher captures its snapshot, without nested pool acquisition. Remote provider calls occur only after that transaction releases the lock. A backend change is rejected while any artifact publish for that project owns a live publishing claim. The ten-minute lease begins at claim insertion using the PostgreSQL clock; stale comparison, failure retirement, and finalization use that same database time source. Expired claims are retired as errors so an owner can repair credentials or switch backend, and a late publisher cannot activate a retired claim. The next publish of an existing local artifact atomically rebinds its current trace link to the newly selected backend and republishes it there; the prior remote artifact is not deleted.

### Plain Jira

Provide the numeric Jira Test Case issue-type ID and an immutable `customfield_<number>` local-ID field. Publishing searches that field before create and reconciles the deterministic story backlink comment. No Jira remote links are created (a pre-release change; previously created `itestflow:test-case:*` remote links are inert and need no Jira-side cleanup).

### Xray Cloud

Provide the Xray Cloud client ID, client secret, and immutable `customfield_<number>` local-ID field. The client secret is encrypted and never returned. Test IDs are project-scoped before Plan or Execution association; warning-bearing partial operations are recovered by stable-ID lookup and reconciliation.

### Zephyr Scale Cloud

Provide the Zephyr Scale API token, the approved US/EU/AU/DE region, and immutable local-ID field name. The token is encrypted and the region selects a closed endpoint allowlist. Case/Cycle identity scans are bounded, execution publishing uses a fenced durable claim, and request headers plus bodies are subject to a 30-second timeout. Trace links open the Zephyr Scale Test Case view for the remote key rather than a Jira issue view.

## Polling and Synchronization

Jira changes arrive by polling: the scheduled workspace sync (Settings → Automation) and the on-demand **Sync now** control both run a full reconciliation using the workspace sync principal's credential (API token or OAuth grant). There is no webhook ingress. Two-way reconciliation stores durable per-field baselines, queues pull or push operations before convergence, pauses unresolved conflicts, and advances baselines only after the selected effect succeeds. A complete reconciliation also detects issues deleted in Jira and retires their mappings; an issue observed again later revives its mapping in the same run. Transient provider failures are retried with a bounded attempt count and honor Atlassian's `Retry-After` on rate limits (clamped to one hour); terminal failures remain visible as `error` or `invalid`.

The sync principal is the first owner's connection (a dead principal keeps its designation so a replaced token or a fresh Atlassian consent resumes polling in place). Scheduled runs that fail because the principal credential is missing, invalid, or awaiting reconsent carry the machine-readable job codes `jira_sync_principal_missing` / `jira_sync_principal_invalid` / `jira_sync_principal_reauthorization_required`, and Settings → Connections shows an actionable callout naming who can fix it.

## Recovery and Diagnostics

- `Invalid token` (connection or sync principal): the token expired (Atlassian caps tokens at one year), was revoked, or was rejected at use time. Where API-token connections are enabled, replace the token in **Settings → Connections**. In OAuth-only mode, the sync owner uses **Reconnect with Atlassian**; either recovery resumes scheduled sync without a principal handover.
- `Reconnect needed` (OAuth connection or sync principal): the Atlassian grant is dead — password change, app access revoked, or an expired refresh token. **Reconnect with Atlassian** in **Settings → Connections**; a token can also be connected in its place when the method is enabled.
- `conflict`: choose **Use iTestFlow** or **Use Jira**. The choice queues convergence; the conflict remains visible until the operation completes.
- `error`: inspect the fixed error code and application audit event. Provider response bodies, tokens, client secrets, and API tokens are deliberately excluded.
- missing trace link: retry publishing with the same immutable local artifact ID. Each backend searches or claims that identity before create.
- project not listed: confirm the connected Atlassian user has Browse Projects permission on the configured site.
- sign-in reports a missing-scopes token: recreate the scoped token with `read:jira-work`, `write:jira-work`, and `read:jira-user`, or use a classic token.

For non-production verification, run focused Jira unit tests, `npm run typecheck`, `npm run build`, and the full `npm test` suite. Run migration up/down against the disposable `TEST_DATABASE_URL`. A real Atlassian/Xray/Zephyr smoke test requires dedicated non-production tenants and remains a deployment gate; do not point it at production.

## Rollback

Disable scheduled workers and capture a database backup before rollback. Revert the application to the last compatible release, then roll back only migrations introduced after that release using the project migration tooling. The dual-auth migration's downgrade deletes stored OAuth credential rows (their secrets are not recoverable) and keeps API-token rows intact; the Jira API-token migration's downgrade recreates the pre-release OAuth-era structures empty: stored API tokens, OAuth secrets, and webhook events are not recoverable — restore the backup if those records must be retained. Workspaces, external identities, projects, sync mappings, backend configuration, and trace links are preserved by the forward migrations and only removed by rolling back further into the pre-Jira era. Azure DevOps workspace rows and credentials are not converted or deleted by Jira setup.
