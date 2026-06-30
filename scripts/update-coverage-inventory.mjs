import { spawnSync } from "node:child_process";
import path from "node:path";

const vitestCli = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitestCli, "run", "--config", "vitest.unit.config.ts"],
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
