import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type {
  AzureTestPoint,
  CreateTestSuiteInput,
  TestSuite,
} from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, projectScope } from "@/test/factories";
import type { TestSuiteMigrationRequest } from "@/types/test-suite-migration";
import {
  buildMigrationPreview,
  executeSuiteMigration,
  loadMigrationSuiteTree,
} from "./test-suite-migration.service";

// Source plan 10: Root(1) -> Checkout(2). Target plan 20: Target(9) with a
// requirement child (8) so a non-static target parent can be selected.
const sourceSuites: TestSuite[] = [{
  id: "1",
  name: "Root",
  planId: "10",
  suiteType: "staticTestSuite",
  children: [{
    id: "2",
    name: "Checkout",
    planId: "10",
    parentSuiteId: "1",
    suiteType: "staticTestSuite",
    children: [],
  }],
}];
const targetSuites: TestSuite[] = [{
  id: "9",
  name: "Target",
  planId: "20",
  suiteType: "staticTestSuite",
  children: [{
    id: "8",
    name: "Requirement child",
    planId: "20",
    parentSuiteId: "9",
    suiteType: "requirementTestSuite",
    requirementId: "555",
    children: [],
  }],
}];

function migrationRequest(overrides: Partial<TestSuiteMigrationRequest> = {}): TestSuiteMigrationRequest {
  return {
    scope: projectScope(),
    sourceProjectId: "azure-project-1",
    sourceTestPlanId: "10",
    selectedSuiteIds: ["1"],
    targetProjectId: "azure-project-1",
    targetTestPlanId: "20",
    targetParentSuiteId: "9",
    operationMode: "copy",
    outcomeMode: "latestOutcome",
    overwriteTargetOutcomes: false,
    conflictStrategy: "renameWithMigratedSuffix",
    ...overrides,
  };
}

function point(id: string, overrides: Partial<AzureTestPoint> = {}): AzureTestPoint {
  return { id, testCaseId: "100", configurationId: "50", ...overrides };
}

// Suite trees are keyed by plan (10 = source, 20 = target); test points are keyed
// by plan then suite so source reads and post-copy target reads stay distinct.
function migrationAdapter(
  input: {
    sourceTree?: TestSuite[];
    sourcePoints?: Record<string, AzureTestPoint[] | Error>;
    targetPoints?: Record<string, AzureTestPoint[]>;
  } = {},
  overrides: Partial<AzureDevOpsAdapter> = {},
) {
  return fakeAzureAdapter({
    fetchTestSuiteTree: vi.fn(async ({ testPlanId }: { projectId: string; testPlanId: string }) =>
      (testPlanId === "10" ? input.sourceTree ?? sourceSuites : targetSuites)),
    fetchTestPoints: vi.fn(async ({ testPlanId, testSuiteId }: { projectId: string; testPlanId: string; testSuiteId: string }) => {
      if (testPlanId === "10") {
        const entry = (input.sourcePoints ?? {})[testSuiteId];
        if (entry instanceof Error) throw entry;
        return entry ?? [];
      }
      return (input.targetPoints ?? {})[testSuiteId] ?? [];
    }),
    ...overrides,
  });
}

// Execution fakes: created suites get id `t-<name>` so parent-chain assertions
// can reference them, and target points are returned at expected counts so the
// retry loop never sleeps.
function executionAdapter(
  input: Parameters<typeof migrationAdapter>[0] = {},
  overrides: Partial<AzureDevOpsAdapter> = {},
) {
  return migrationAdapter(input, {
    createTestSuite: vi.fn(async ({ name }: CreateTestSuiteInput) => ({
      success: true,
      suite: { id: `t-${name}`, name, planId: "20" },
    })),
    addTestCasesToSuite: vi.fn(async ({ testCases }: { testCases: Array<{ testCaseId: string }> }) => ({
      success: true,
      addedCount: testCases.length,
      errors: [],
    })),
    updateTestPoints: vi.fn(async () => ({ success: true })),
    deleteTestSuite: vi.fn(async () => ({ success: true })),
    ...overrides,
  });
}

describe("loadMigrationSuiteTree", () => {
  it("fetches the plan tree and computes hierarchical paths", async () => {
    const adapter = migrationAdapter();
    const tree = await loadMigrationSuiteTree(adapter, { projectId: "azure-project-1", testPlanId: "10" });
    expect(adapter.fetchTestSuiteTree).toHaveBeenCalledWith({ projectId: "azure-project-1", testPlanId: "10" });
    expect(tree[0]).toMatchObject({ id: "1", path: "Root" });
    expect(tree[0]?.children[0]).toMatchObject({ id: "2", path: "Root / Checkout" });
  });
});

describe("buildMigrationPreview", () => {
  it.each<[string, Partial<TestSuiteMigrationRequest>, string[]]>([
    ["selected-suite-not-found", { selectedSuiteIds: ["404"] }, ["selected-suite-not-found", "no-suite-selected"]],
    ["no-suite-selected", { selectedSuiteIds: [] }, ["no-suite-selected"]],
    ["target-parent-not-found", { targetParentSuiteId: "999" }, ["target-parent-not-found"]],
    ["target-parent-not-static", { targetParentSuiteId: "8" }, ["target-parent-not-static"]],
    // Same plan on both sides and the parent is a descendant of the selected root.
    ["target-inside-source", { targetTestPlanId: "10", targetParentSuiteId: "2" }, ["target-inside-source"]],
    ["project-scope-mismatch", { sourceProjectId: "another-project" }, ["project-scope-mismatch"]],
  ])("flags %s as a blocking error and fails the preview", async (_kind, overrides, expectedCodes) => {
    const preview = await buildMigrationPreview(migrationAdapter(), migrationRequest(overrides));
    expect(preview.status).toBe("failed");
    expect(preview.errors.map((error) => error.code)).toEqual(expectedCodes);
  });

  it("computes counts, rows, and outcome breakdown for a clean selection", async () => {
    const adapter = migrationAdapter({
      sourcePoints: {
        "1": [
          point("sp-1", { outcome: "passed", configurationName: "Windows" }),
          point("sp-3", { testCaseId: undefined, outcome: "notExecuted" }),
        ],
        "2": [point("sp-2", { testCaseId: "200", outcome: "failed" })],
      },
    });
    const preview = await buildMigrationPreview(adapter, migrationRequest());

    expect(preview.status).toBe("readyToMigrate");
    expect(preview.errors).toEqual([]);
    expect(preview).toMatchObject({
      selectedRootSuiteCount: 1,
      totalSuiteCount: 2,
      childSuitesIncludedCount: 1,
      totalSourceTestCaseCount: 2,
      totalSourceTestPointCount: 3,
      expectedTargetSuiteCount: 2,
      expectedTargetTestPointCount: 3,
      mappableOutcomeCount: 2,
      unmappedTestPointCount: 1,
    });
    expect(preview.outcomeBreakdown).toMatchObject({
      Passed: 1,
      Failed: 1,
      "Not Executed": 1,
      Blocked: 0,
    });
    expect(preview.selectedRoots.map((root) => root.id)).toEqual(["1"]);
    expect(preview.plannedSuites.map((suite) => suite.targetSuitePath)).toEqual([
      "Target / Root",
      "Target / Root / Checkout",
    ]);
    expect(preview.rows[0]).toMatchObject({
      sourceRootSuite: "Root",
      sourceSuitePath: "Root",
      targetSuitePath: "Target / Root",
      sourceConfiguration: "Windows",
      sourceLatestOutcome: "Passed",
      plannedAction: "Copy and migrate latest outcome",
      warningOrError: undefined,
    });
    expect(preview.rows[1]).toMatchObject({
      plannedAction: "Copy only",
      warningOrError: "Missing test case or configuration ID.",
    });
    expect(preview.rows[2]).toMatchObject({
      sourceRootSuite: "Root",
      sourceSuitePath: "Root / Checkout",
      targetSuitePath: "Target / Root / Checkout",
      sourceLatestOutcome: "Failed",
    });
  });

  it("records point-read-failed without dropping points from readable suites", async () => {
    const adapter = migrationAdapter({
      sourcePoints: {
        "1": [point("sp-1", { outcome: "passed" })],
        "2": new Error("suite 2 read failed"),
      },
    });
    const preview = await buildMigrationPreview(adapter, migrationRequest());
    expect(preview.errors).toEqual([
      expect.objectContaining({ code: "point-read-failed", suiteId: "2", message: "suite 2 read failed" }),
    ]);
    expect(preview.totalSourceTestPointCount).toBe(1);
  });
});

describe("executeSuiteMigration", () => {
  it("throws the first blocking preview error before any adapter write", async () => {
    const createTestSuite = vi.fn(async () => ({ success: true }));
    const adapter = migrationAdapter({}, { createTestSuite });
    // Scope mismatch is recorded before the missing target parent, so it wins.
    await expect(executeSuiteMigration(adapter, {
      ...migrationRequest({ sourceProjectId: "another-project", targetParentSuiteId: "999" }),
      actor: "qa",
    })).rejects.toThrow("Source and target suites must be in the selected Azure DevOps project.");
    expect(createTestSuite).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("proceeds past a non-blocking point-read-failed error", async () => {
    const adapter = executionAdapter({
      sourcePoints: {
        "1": [point("sp-1", { outcome: "passed" })],
        "2": new Error("suite 2 read failed"),
      },
      targetPoints: { "t-Root": [point("tp-1")], "t-Checkout": [] },
    });
    const result = await executeSuiteMigration(adapter, { ...migrationRequest(), actor: "qa" });
    expect(result.preview.errors).toEqual([expect.objectContaining({ code: "point-read-failed" })]);
    expect(result.report.status).toBe("completed");
    expect(adapter.updateTestPoints).toHaveBeenCalledTimes(1);
    expect(adapter.updateTestPoints).toHaveBeenCalledWith(expect.objectContaining({
      testSuiteId: "t-Root",
      pointIds: ["tp-1"],
      outcome: "passed",
    }));
  });

  it("copies suites under the created parent chain and preserves outcomes", async () => {
    const adapter = executionAdapter({
      sourcePoints: {
        "1": [point("sp-1", { outcome: "passed" })],
        "2": [point("sp-2", { testCaseId: "200", outcome: "failed" })],
      },
      targetPoints: {
        "t-Root": [point("tp-1")],
        "t-Checkout": [point("tp-2", { testCaseId: "200" })],
      },
    });
    const result = await executeSuiteMigration(adapter, { ...migrationRequest(), actor: "qa" });

    // Root is created under the requested target parent; the child under the
    // suite the migration just created, not under the source parent id.
    expect(adapter.createTestSuite).toHaveBeenNthCalledWith(1, expect.objectContaining({
      projectId: "azure-project-1",
      testPlanId: "20",
      parentSuiteId: "9",
      name: "Root",
      suiteType: "staticTestSuite",
    }));
    expect(adapter.createTestSuite).toHaveBeenNthCalledWith(2, expect.objectContaining({
      parentSuiteId: "t-Root",
      name: "Checkout",
    }));
    expect(adapter.addTestCasesToSuite).toHaveBeenCalledWith(expect.objectContaining({
      testSuiteId: "t-Root",
      testCases: [{ testCaseId: "100", configurationIds: ["50"] }],
    }));
    expect(adapter.addTestCasesToSuite).toHaveBeenCalledWith(expect.objectContaining({
      testSuiteId: "t-Checkout",
      testCases: [{ testCaseId: "200", configurationIds: ["50"] }],
    }));
    expect(adapter.updateTestPoints).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      testPlanId: "20",
      testSuiteId: "t-Root",
      pointIds: ["tp-1"],
      outcome: "passed",
    });
    expect(adapter.updateTestPoints).toHaveBeenCalledWith(expect.objectContaining({
      testSuiteId: "t-Checkout",
      pointIds: ["tp-2"],
      outcome: "failed",
    }));
    expect(adapter.deleteTestSuite).not.toHaveBeenCalled();
    expect(result.report.status).toBe("completed");
    expect(result.report.summary).toMatchObject({
      suitesCreated: 2,
      testCasesAdded: 2,
      outcomesUpdated: 2,
      outcomesFailed: 0,
      sourceSuitesDeleted: 0,
    });
    expect(result.report.suiteMappings).toEqual([
      expect.objectContaining({ sourceSuiteId: "1", targetSuiteId: "t-Root", targetSuitePath: "Target / Root" }),
      expect.objectContaining({ sourceSuiteId: "2", targetSuiteId: "t-Checkout", targetSuitePath: "Target / Root / Checkout" }),
    ]);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actor: "qa",
      action: "azure_devops.test_suite_migration",
      entityId: "1",
      status: "Success",
    }));
  });

  it("deletes only the selected source roots after a clean move", async () => {
    const adapter = executionAdapter({
      sourcePoints: { "1": [point("sp-1", { outcome: "passed" })], "2": [] },
      targetPoints: { "t-Root": [point("tp-1")], "t-Checkout": [] },
    });
    const result = await executeSuiteMigration(adapter, {
      ...migrationRequest({ operationMode: "move" }),
      actor: "qa",
    });
    expect(adapter.deleteTestSuite).toHaveBeenCalledTimes(1);
    expect(adapter.deleteTestSuite).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      testPlanId: "10",
      testSuiteId: "1",
    });
    expect(result.report.status).toBe("completed");
    expect(result.report.summary.sourceSuitesDeleted).toBe(1);
  });

  it("blocks source deletion when a move has critical failures", async () => {
    const adapter = executionAdapter({
      sourcePoints: { "1": [point("sp-1", { outcome: "passed" })], "2": [] },
      targetPoints: { "t-Root": [point("tp-1")], "t-Checkout": [] },
    }, {
      updateTestPoints: vi.fn(async () => ({ success: false, error: "outcome update rejected" })),
    });
    const result = await executeSuiteMigration(adapter, {
      ...migrationRequest({ operationMode: "move" }),
      actor: "qa",
    });
    expect(adapter.deleteTestSuite).not.toHaveBeenCalled();
    expect(result.report.warnings).toEqual([
      expect.objectContaining({ code: "move-source-delete-blocked" }),
    ]);
    expect(result.report.errors).toEqual([
      expect.objectContaining({ code: "outcome-update-failed", message: "outcome update rejected" }),
    ]);
    // Suites were still created, so the run is partial rather than failed.
    expect(result.report.status).toBe("partiallyCompleted");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ status: "Partial failure" }));
  });

  it("skips descendants whose parent suite creation failed", async () => {
    const addTestCasesToSuite = vi.fn(async () => ({ success: true, addedCount: 0, errors: [] }));
    const adapter = executionAdapter({
      sourcePoints: { "1": [point("sp-1", { outcome: "passed" })], "2": [] },
    }, {
      createTestSuite: vi.fn(async () => ({ success: false, error: "suite create rejected" })),
      addTestCasesToSuite,
    });
    const result = await executeSuiteMigration(adapter, { ...migrationRequest(), actor: "qa" });

    // Root fails once (static, so no fallback retry); the child never attempts.
    expect(adapter.createTestSuite).toHaveBeenCalledTimes(1);
    expect(addTestCasesToSuite).not.toHaveBeenCalled();
    expect(result.report.actions).toEqual([
      expect.objectContaining({ action: "createSuite", status: "failed", sourceSuiteId: "1" }),
      expect.objectContaining({ action: "createSuite", status: "skipped", sourceSuiteId: "2" }),
    ]);
    expect(result.report.errors.map((error) => error.code)).toEqual([
      "suite-create-failed",
      "target-parent-missing",
    ]);
    expect(result.report.status).toBe("failed");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ status: "Failed" }));
  });

  it("falls back to a static suite when the source suite type cannot be preserved", async () => {
    const requirementRoot: TestSuite[] = [{
      id: "1",
      name: "Reqs",
      planId: "10",
      suiteType: "requirementTestSuite",
      requirementId: "555",
      children: [],
    }];
    const adapter = executionAdapter({
      sourceTree: requirementRoot,
      sourcePoints: { "1": [] },
    }, {
      createTestSuite: vi.fn(async (input: CreateTestSuiteInput) => (
        input.suiteType === "staticTestSuite"
          ? { success: true, suite: { id: "t-Reqs", name: input.name, planId: "20" } }
          : { success: false, error: "requirement suites unsupported" }
      )),
    });
    const result = await executeSuiteMigration(adapter, { ...migrationRequest(), actor: "qa" });

    expect(adapter.createTestSuite).toHaveBeenNthCalledWith(1, expect.objectContaining({
      suiteType: "requirementTestSuite",
      requirementId: "555",
    }));
    expect(adapter.createTestSuite).toHaveBeenNthCalledWith(2, expect.objectContaining({
      suiteType: "staticTestSuite",
      requirementId: undefined,
    }));
    expect(result.report.warnings).toEqual([
      expect.objectContaining({ code: "suite-type-fallback", suiteId: "1" }),
    ]);
    expect(result.report.summary.suitesCreated).toBe(1);
  });

  it("skips outcome writes when the mode disables them or the target already has one", async () => {
    const points = {
      sourcePoints: { "1": [point("sp-1", { outcome: "passed" })], "2": [] },
      targetPoints: { "t-Root": [point("tp-1", { outcome: "failed" })], "t-Checkout": [] },
    };

    // Target point already has an outcome and overwrite is disabled.
    const keepExisting = executionAdapter(points);
    const kept = await executeSuiteMigration(keepExisting, { ...migrationRequest(), actor: "qa" });
    expect(keepExisting.updateTestPoints).not.toHaveBeenCalled();
    expect(kept.report.summary).toMatchObject({ outcomesUpdated: 0, outcomesSkipped: 1 });

    // Overwrite enabled applies the source outcome over the existing one.
    const overwrite = executionAdapter(points);
    await executeSuiteMigration(overwrite, {
      ...migrationRequest({ overwriteTargetOutcomes: true }),
      actor: "qa",
    });
    expect(overwrite.updateTestPoints).toHaveBeenCalledWith(expect.objectContaining({
      pointIds: ["tp-1"],
      outcome: "passed",
    }));

    // Outcome mode "none" skips the whole outcome phase.
    const disabled = executionAdapter(points);
    const skipped = await executeSuiteMigration(disabled, {
      ...migrationRequest({ outcomeMode: "none" }),
      actor: "qa",
    });
    expect(disabled.updateTestPoints).not.toHaveBeenCalled();
    expect(skipped.report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "skipOutcome", message: "Outcome migration was disabled by the selected mode." }),
    ]));
  });
});
