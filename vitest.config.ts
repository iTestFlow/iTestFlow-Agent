import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { COVERAGE_EXCLUDE } from "./vitest.coverage-manifest";

// Wire the same "@/*" alias as tsconfig.json so tests can value-import from "@/..."
// (today only type-only imports are used, which esbuild strips, but this prevents a
// latent break the first time a test imports runtime code via the alias).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Neutralize the RSC-only guard so server modules' pure helpers are unit-testable.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Test-file SELECTION lives in the lane configs, NOT here: vitest.unit.config.ts
    // includes all non-DB tests; vitest.integration.config.ts includes only *.db.test.*.
    // Keeping `include` out of the base is deliberate — mergeConfig CONCATENATES arrays,
    // so a base `include` would merge with each lane's and make the lane globs a no-op.
    setupFiles: ["./src/test/setup.ts"],
    // NOTE: serial file execution (fileParallelism: false) lives in
    // vitest.integration.config.ts — only the DB-backed lane needs it. The unit and
    // coverage lanes keep vitest's default file parallelism for a faster PR gate.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Shared with the staleness guard (src/test/coverage-gate.ts) via ./vitest.coverage-manifest.
      exclude: COVERAGE_EXCLUDE,
    },
  },
});
