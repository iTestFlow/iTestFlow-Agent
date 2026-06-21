import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import { startContextAutoUpdateScheduler } from "@/modules/rag/context-auto-update.scheduler";

// Seed the bootstrap owner/workspace on startup (idempotent, no-op without the
// BOOTSTRAP_OWNER_* env vars). Best-effort: a failure (e.g. database not yet
// migrated) is logged, not fatal, so the app can still boot.
void ensureBootstrapOwner().catch((error) => {
  console.error("[bootstrap] ensureBootstrapOwner failed; continuing.", error);
});

startContextAutoUpdateScheduler();
