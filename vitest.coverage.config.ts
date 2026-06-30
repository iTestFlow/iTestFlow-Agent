import { mergeConfig } from "vitest/config";

import unitConfig from "./vitest.unit.config";
import { GATED_INCLUDE } from "./vitest.coverage-manifest";

/**
 * The enforced RISK-BASED coverage gate — NOT a repository-wide coverage measure.
 *
 * Thresholds apply ONLY to the curated `include` allowlist below (deterministic domain
 * logic + boundary adapters). Source files not listed here are not measured by this
 * gate, so its reported percentage means "coverage of the gated high-risk logic," not
 * the whole repo (run `npm run test:coverage:all` for the broader non-gated report
 * across its configured source roots; persistence-heavy services are covered in the
 * PostgreSQL integration lane via `npm run test:integration`). Thresholds are
 * AGGREGATE (no `perFile`), so a strongly covered file can offset a weaker one.
 *
 * Adding a new high-risk module? Add its exact path to GATED_INCLUDE in
 * `vitest.coverage-manifest.ts`. The meta-test
 * `src/test/coverage-manifest.integrity.test.ts` fails if any entry goes stale
 * (renamed/deleted), so the allowlist cannot silently shrink.
 */
export default mergeConfig(unitConfig, {
  test: {
    coverage: {
      // Allowlist lives in ./vitest.coverage-manifest.ts (shared with the staleness guard
      // in src/test/coverage-gate.ts so the two never disagree).
      include: GATED_INCLUDE,
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
        "src/modules/{scoring,settings}/**/*.ts": {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 90,
        },
        "src/modules/bug-reporting/schemas/*.ts": {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 90,
        },
      },
    },
  },
});
