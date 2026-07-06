import { spawnSync } from "node:child_process";
import path from "node:path";

const vitestCli = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [
    vitestCli,
    "run",
    // Only the integrity guard writes the inventory (via UPDATE_COVERAGE_INVENTORY),
    // so run just that file instead of the whole unit lane.
    "src/test/coverage-manifest.integrity.test.ts",
    "--config",
    "vitest.unit.config.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      UPDATE_COVERAGE_INVENTORY: "1",
    },
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
