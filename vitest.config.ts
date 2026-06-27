import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Wire the same "@/*" alias as tsconfig.json so tests can value-import from "@/..."
// (today only type-only imports are used, which esbuild strips, but this prevents a
// latent break the first time a test imports runtime code via the alias).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Neutralize the RSC-only guard so server modules' pure helpers are unit-testable.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // DB-backed integration tests (gated on DATABASE_URL) share a single Postgres
    // database and use global queries (e.g. the job queue's claimNextJob scans all
    // workspaces). Run test files serially so one file's rows can't leak into
    // another's assertions. Pure unit tests are unaffected (the suite is ~seconds).
    fileParallelism: false,
  },
});
