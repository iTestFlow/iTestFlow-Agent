import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";

// Seed the bootstrap owner/workspace on startup (idempotent, no-op without the
// BOOTSTRAP_OWNER_* env vars). Best-effort: a failure (e.g. database not yet
// migrated) is logged, not fatal, so the app can still boot.
//
// Scheduled background work (Azure DevOps context sync) is owned by the dedicated
// worker process (Phase 4: `npm run worker`), not the web app.
void ensureBootstrapOwner().catch((error) => {
  console.error("[bootstrap] ensureBootstrapOwner failed; continuing.", error);
});
