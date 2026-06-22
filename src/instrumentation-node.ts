import path from "path";
import migrate from "node-pg-migrate";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[migrations] DATABASE_URL not set — skipping auto-migration.");
    return;
  }
  await migrate({
    databaseUrl,
    direction: "up",
    dir: path.join(process.cwd(), "migrations"),
    migrationsTable: "pgmigrations",
    log: (msg) => console.log("[migrations]", msg),
  });
}

// Run pending migrations on every startup, then seed the bootstrap owner.
// Both are idempotent: already-applied migrations are skipped, and the owner
// seed is a no-op when the row already exists.
void runMigrations()
  .then(() => ensureBootstrapOwner())
  .catch((error) => {
    console.error("[startup] Migration or bootstrap failed; continuing.", error);
  });

