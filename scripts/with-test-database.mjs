import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";

// Keep integration tests away from the application's development database. The
// app itself loads .env through Next.js, while standalone npm scripts do not.
// Load it here solely to obtain TEST_DATABASE_URL, then explicitly pass that
// value to the child as DATABASE_URL.
if (existsSync(".env")) process.loadEnvFile(".env");

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const [entrypoint, ...args] = process.argv.slice(2);

if (!testDatabaseUrl) {
  console.error(
    "TEST_DATABASE_URL is required for database integration commands. Set it to the disposable test database (for Docker, port 5433 / database itestflow_test).",
  );
  process.exit(1);
}

if (!entrypoint) {
  console.error("Usage: node scripts/with-test-database.mjs <node-entrypoint> [...args]");
  process.exit(1);
}

const appDatabaseUrl = process.env.DATABASE_URL?.trim();
if (appDatabaseUrl && sameDatabase(appDatabaseUrl, testDatabaseUrl)) {
  console.error("TEST_DATABASE_URL must point to a different database than DATABASE_URL.");
  process.exit(1);
}

const child = spawn(process.execPath, [entrypoint, ...args], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Failed to start test database command: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Test database command stopped by ${signal}.`);
    process.exitCode = 128 + (constants.signals[signal] ?? 1);
    return;
  }
  process.exitCode = code ?? 1;
});

function sameDatabase(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const protocol = (value) => (value === "postgres:" || value === "postgresql:" ? "postgres" : value);
    const port = (value) => value || "5432";
    return (
      protocol(a.protocol) === protocol(b.protocol) &&
      normalizedHost(a.hostname) === normalizedHost(b.hostname) &&
      port(a.port) === port(b.port) &&
      a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "")
    );
  } catch {
    // The database client provides the detailed validation error for malformed
    // connection strings. Do not prevent that error from surfacing here.
    return false;
  }
}

function normalizedHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" ? "loopback" : host;
}
