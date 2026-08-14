import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW,
  reportableWorkflowTypeValues,
  workflowLabels,
  workflowTypeValues,
} from "@/modules/analytics/analytics-config";

const ROOT = process.cwd();

const RETIRED_PATHS = [
  "src/app/test-execution-effort/page.tsx",
  "src/app/test-execution-effort/test-execution-effort-client.tsx",
  "src/app/api/test-execution-effort/prepare/route.ts",
  "src/app/api/test-execution-effort/generate/route.ts",
  "src/app/api/test-execution-effort/external-prompt/route.ts",
  "src/app/api/test-execution-effort/manual/submit/route.ts",
  "src/app/api/test-execution-effort/route-error-handling.test.ts",
  "src/modules/test-execution-effort/test-execution-effort.data-loader.ts",
  "src/modules/test-execution-effort/test-execution-effort.schema.ts",
  "src/modules/test-execution-effort/test-execution-effort.service.ts",
  "src/modules/test-execution-effort/test-execution-effort.test.ts",
  "src/modules/llm/prompts/test-execution-effort.prompt.ts",
] as const;

const ALLOWED_IDENTITY_PATHS = new Set([
  "src/middleware.ts",
  "src/modules/analytics/analytics-config.ts",
  "src/modules/analytics/system-dashboard.service.db.test.ts",
  "src/test/middleware-retired-route.test.ts",
  "src/test/test-execution-effort-retirement.test.ts",
]);

const RETIRED_IDENTITIES = [
  "/test-execution-effort",
  "test-execution-effort",
  "test_execution_effort",
  "TestExecutionEffort",
  "Test Execution Effort",
  "Execution`nEffort",
  "Effort`nEstimates",
  "execution planning",
  "estimate execution effort",
] as const;

const TEXT_ROOTS = ["src", "scripts"] as const;
const TEXT_FILES = ["README.md", "PROJECT_ARCHITECTURE.md", "vitest.coverage-manifest.ts"] as const;

function collectTextFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];

  return readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => /\.(?:ts|tsx|js|mjs|json|md|ps1)$/.test(file));
}

describe("Test Execution Effort retirement", () => {
  it("removes the page, API handlers, domain module, prompt, tests, and exact feature identities", () => {
    const existingRetiredPaths = RETIRED_PATHS.filter((relativePath) => existsSync(path.join(ROOT, relativePath)));
    expect(existingRetiredPaths).toEqual([]);

    const files = [
      ...TEXT_ROOTS.flatMap(collectTextFiles),
      ...TEXT_FILES.map((relativePath) => path.join(ROOT, relativePath)),
    ];
    const staleReferences = files.flatMap((file) => {
      const relativeFile = path.relative(ROOT, file).replace(/\\/g, "/");
      if (!existsSync(file) || ALLOWED_IDENTITY_PATHS.has(relativeFile)) return [];
      const text = readFileSync(file, "utf8");
      return RETIRED_IDENTITIES
        .filter((identity) => text.includes(identity))
        .map((identity) => `${path.relative(ROOT, file).replace(/\\/g, "/")}: ${identity}`);
    });

    expect(staleReferences).toEqual([]);
  });

  it("keeps historical analytics reportable without offering the retired workflow", () => {
    expect(workflowTypeValues).not.toContain(LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW);
    expect(reportableWorkflowTypeValues).toContain(LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW);
    expect(workflowLabels[LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW]).toBe("Legacy execution estimate");
  });

  it("preserves generic workflow effort analytics and their persisted schema", () => {
    expect(existsSync(path.join(ROOT, "src/modules/analytics/analytics-metrics.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "migrations/1710000012000_workspace_settings_baselines.js"))).toBe(true);
    expect(existsSync(path.join(ROOT, "migrations/1710000013000_workflow_run_effort_breakdown.js"))).toBe(true);

    const metrics = readFileSync(path.join(ROOT, "src/modules/analytics/analytics-metrics.ts"), "utf8");
    expect(metrics).toContain("calculateLaborSaved");
    expect(metrics).toContain("calculateCycleSaved");
  });
});
