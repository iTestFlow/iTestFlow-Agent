import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { GATED_INCLUDE } from "../vitest.coverage-manifest.ts";

/**
 * Per-file floor for the risk-based coverage gate — the companion to the AGGREGATE
 * thresholds in vitest.coverage.config.ts. Vitest enforces thresholds either
 * aggregate OR per-file (thresholds.perFile), never both in one run, so the
 * aggregate 80/70 gate lives in vitest and this script enforces the floor each
 * individual gated file must clear. Without it, a strongly covered file can mask a
 * "gated but effectively untested" newcomer.
 *
 * Runs as part of `npm run test:coverage` (chained after vitest) against the
 * json-summary report, which contains exactly the GATED_INCLUDE files.
 */
const FLOOR = { lines: 60, statements: 60, functions: 60, branches: 50 };

const summaryPath = path.join(process.cwd(), "coverage", "coverage-summary.json");
if (!existsSync(summaryPath)) {
  console.error(`[coverage-floor] ${summaryPath} not found — run the coverage lane first.`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const failures = [];

function canonicalPath(file) {
  return path.resolve(file).split(path.sep).join("/");
}

const reportedFiles = new Map(
  Object.entries(summary)
    .filter(([file]) => file !== "total")
    .map(([file, metrics]) => [canonicalPath(file), metrics]),
);

for (const gatedFile of GATED_INCLUDE) {
  const rel = gatedFile.split(path.sep).join("/");
  const metrics = reportedFiles.get(canonicalPath(gatedFile));
  if (!metrics) {
    failures.push(`${rel}: missing from coverage-summary.json`);
    continue;
  }

  for (const [metric, floor] of Object.entries(FLOOR)) {
    const pct = metrics[metric]?.pct;
    if (typeof pct !== "number" || !Number.isFinite(pct)) {
      failures.push(`${rel}: ${metric} percentage is missing or invalid`);
    } else if (pct < floor) {
      failures.push(`${rel}: ${metric} ${pct}% < ${floor}%`);
    }
  }
}

if (failures.length) {
  console.error(`[coverage-floor] ${failures.length} gated coverage validation failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("[coverage-floor] Strengthen the file's tests (or, if it was gated prematurely, remove it from GATED_INCLUDE).");
  process.exit(1);
}

console.log("[coverage-floor] All gated files clear the per-file floor.");
