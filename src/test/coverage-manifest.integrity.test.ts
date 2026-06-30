import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ROOT,
  UNGATED_INVENTORY_REL,
  gatedIncludePatterns,
  isExcluded,
  isGated,
  listLogicFiles,
  loadUngatedInventory,
  patternResolves,
} from "./coverage-gate";

/**
 * Guards the risk-based coverage gate (vitest.coverage.config.ts) against silent staleness.
 *
 * The gate enforces thresholds on a CURATED allowlist of high-risk source files — it is
 * deliberately NOT repo-wide. Two ways that allowlist can rot without any CI failure:
 *  1. SHRINK — a gated file is renamed/deleted, so its logic stops being enforced.
 *  2. GROW    — a new high-risk file is added but never gated, escaping enforcement.
 * These tests fail loudly for both. Neither asserts repo-wide coverage.
 */
describe("coverage gate manifest integrity (no silent shrink)", () => {
  const patterns = gatedIncludePatterns();

  it("extracts a non-empty manifest", () => {
    expect(patterns.length).toBeGreaterThan(0);
  });

  it("has no duplicate entries", () => {
    const duplicates = patterns.filter((p, i) => patterns.indexOf(p) !== i);
    expect(duplicates).toEqual([]);
  });

  it("uses exact file paths only (no wildcard shrinkage)", () => {
    const unsupported = patterns.filter((p) => p.includes("*"));
    expect(
      unsupported,
      "Coverage-gate entries must be exact file paths so deleting or renaming any gated " +
        "source file fails this guard. Replace wildcard entries with explicit paths:\n" +
        unsupported.join("\n"),
    ).toEqual([]);
  });

  it("every gated path resolves to at least one existing source file", () => {
    const missing = patterns.filter((p) => !patternResolves(p));
    expect(
      missing,
      `Stale coverage-gate entries (renamed/deleted without updating vitest.coverage.config.ts):\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});

describe("coverage gate categorization (no silent growth)", () => {
  const logic = listLogicFiles();
  const patterns = gatedIncludePatterns();

  // Refresh path: `npm run coverage:inventory:update` rewrites the inventory
  // from the SAME computation the assertions use, so the snapshot can never drift from them.
  if (process.env.UPDATE_COVERAGE_INVENTORY === "1") {
    it("regenerates the ungated inventory snapshot", () => {
      const ungated = logic.filter((f) => !isGated(f, patterns));
      const payload = {
        description:
          "Logic files intentionally NOT in the risk-based coverage gate (vitest.coverage.config.ts). " +
          "A new logic file must be gated OR added here. Refresh with `npm run coverage:inventory:update`. " +
          "Guarded by src/test/coverage-manifest.integrity.test.ts.",
        ungated,
      };
      writeFileSync(path.join(ROOT, UNGATED_INVENTORY_REL), JSON.stringify(payload, null, 2) + "\n");
      expect(ungated.length).toBeGreaterThan(0);
    });
    return;
  }

  const inventory = loadUngatedInventory();

  it("discovers a non-empty logic universe", () => {
    expect(logic.length).toBeGreaterThan(0);
  });

  it("every logic file is either gated or acknowledged as ungated", () => {
    const acknowledged = new Set(inventory);
    const uncategorized = logic.filter((f) => !isGated(f, patterns) && !acknowledged.has(f));
    expect(
      uncategorized,
      "New logic file(s) are neither coverage-gated nor acknowledged as ungated. For each, EITHER add it " +
        `to the include list in vitest.coverage.config.ts (preferred for high-risk logic) OR run ` +
        `\`npm run coverage:inventory:update\` to acknowledge it in ${UNGATED_INVENTORY_REL}:\n${uncategorized.join("\n")}`,
    ).toEqual([]);
  });

  it("the ungated inventory has no stale or now-gated entries", () => {
    const logicSet = new Set(logic);
    const stale = inventory.filter((f) => !logicSet.has(f));
    const nowGated = inventory.filter((f) => isGated(f, patterns));
    expect(
      stale,
      `Inventory entries that no longer exist as logic files — remove from ${UNGATED_INVENTORY_REL} (or run the refresh):\n${stale.join("\n")}`,
    ).toEqual([]);
    expect(
      nowGated,
      `Inventory entries that are now gated — remove from ${UNGATED_INVENTORY_REL} (or run the refresh):\n${nowGated.join("\n")}`,
    ).toEqual([]);
  });
});

describe("coverage exclude matcher (shared with vitest coverage.exclude)", () => {
  it("excludes exactly the files vitest does not measure", () => {
    for (const f of [
      "src/modules/foo.test.ts",
      "src/modules/sub/foo.spec.tsx",
      "src/shared/x.d.ts",
      "src/modules/bar-types.ts",
      "src/modules/types.ts",
      "src/modules/integrations/azure-devops/azure-devops-adapter.ts",
      "src/modules/shared/infrastructure/database/db.ts",
      "src/components/workflow/llm-loading-games/snake.tsx",
    ]) {
      expect(isExcluded(f), `expected EXCLUDED: ${f}`).toBe(true);
    }
  });

  it("does not exclude real logic files (incl. nested game .tsx, which the single-level glob misses)", () => {
    for (const f of [
      "src/modules/scoring/scoring.service.ts",
      "src/lib/utils.ts",
      "src/app/api/auth/login/route.ts",
      "src/middleware.ts",
      "src/components/workflow/llm-loading-games/nested/deep.tsx",
    ]) {
      expect(isExcluded(f), `expected NOT excluded: ${f}`).toBe(false);
    }
  });
});
