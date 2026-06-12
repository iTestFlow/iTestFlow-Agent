import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Wire the same "@/*" alias as tsconfig.json so tests can value-import from "@/..."
// (today only type-only imports are used, which esbuild strips, but this prevents a
// latent break the first time a test imports runtime code via the alias).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
