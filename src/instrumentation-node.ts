import path from "path";
import migrate from "node-pg-migrate";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";

async function runMigrations() {
  await migrate({
    databaseUrl: process.env.DATABASE_URL!,
    direction: "up",
    dir: path.join(process.cwd(), "migrations"),
    migrationsTable: "pgmigrations",
    log: (msg) => console.log("[migrations]", msg),
  });
}

/**
 * Apply pending migrations on startup, then seed the bootstrap owner. Both are
 * idempotent: already-applied migrations are skipped and the owner seed is a no-op
 * when the row exists.
 *
 * Failure is FATAL (process.exit(1)): serving requests against a database that is
 * un-migrated or missing its bootstrap owner would corrupt data or 500 every
 * route, and silently continuing would mask the INV-4 "migrate before code"
 * guarantee. The only soft path is a missing DATABASE_URL (local inspection
 * without a DB), which skips both.
 */
async function runStartup() {
  if (!process.env.DATABASE_URL) {
    console.warn("[startup] DATABASE_URL not set — skipping auto-migration and bootstrap.");
    return;
  }
  await runMigrations();
  await ensureBootstrapOwner();
}

void runStartup().catch((error) => {
  console.error("[startup] Migration or bootstrap failed; refusing to start.", error);
  process.exit(1);
});

