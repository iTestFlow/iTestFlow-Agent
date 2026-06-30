import { mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

export default mergeConfig(baseConfig, {
  test: {
    include: ["src/**/*.db.test.{ts,tsx}"],
    // Keep this lane identifiable when its results are merged with the unit lane
    // in GitHub Actions. Local runs retain Vitest's normal default reporter.
    reporters:
      process.env.GITHUB_ACTIONS === "true"
        ? ["default", ["junit", { suiteName: "PostgreSQL integration" }]]
        : undefined,
    outputFile:
      process.env.GITHUB_ACTIONS === "true"
        ? { junit: "./reports/integration.xml" }
        : undefined,
    // DB-backed integration tests (gated on DATABASE_URL) share a single Postgres
    // database and use global queries (e.g. the job queue's claimNextJob scans all
    // workspaces). Run test files serially so one file's rows can't leak into
    // another's assertions. (The unit/coverage lanes do NOT inherit this — they touch
    // no shared external state and run with vitest's default file parallelism.)
    fileParallelism: false,
    coverage: {
      enabled: false,
    },
  },
});
