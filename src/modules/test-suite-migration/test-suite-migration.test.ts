import { describe, expect, it } from "vitest";

import { projectScope } from "@/test/factories";
import {
  collectIncludedSuites,
  findSuiteNode,
  flattenSuiteTree,
  hasActionableOutcome,
  normalizeOutcomeForAzure,
  normalizeSelectedSuiteRoots,
  outcomeCategory,
  planTargetSuites,
  pointMatchKey,
  targetOutcomeExists,
  toSuiteTreeNodes,
} from "./test-suite-migration.logic";
import { SuiteMigrationRequestSchema, azureIdSchema } from "./test-suite-migration.schema";

const sourceTree = toSuiteTreeNodes([{
  id: "1",
  name: "Root",
  planId: "10",
  suiteType: "StaticTestSuite",
  children: [{
    id: "2",
    name: "Checkout",
    planId: "10",
    parentSuiteId: "1",
    suiteType: "StaticTestSuite",
    children: [],
  }],
}]);
const targetTree = toSuiteTreeNodes([{
  id: "9",
  name: "Target",
  planId: "20",
  suiteType: "StaticTestSuite",
  children: [{
    id: "8",
    name: "Root",
    planId: "20",
    parentSuiteId: "9",
    suiteType: "StaticTestSuite",
    children: [],
  }],
}]);

describe("test suite migration planning", () => {
  it("flattens, finds, and includes descendants", () => {
    expect(flattenSuiteTree(sourceTree).map((suite) => suite.id)).toEqual(["1", "2"]);
    expect(findSuiteNode(sourceTree, "2")?.path).toBe("Root / Checkout");
    const normalized = normalizeSelectedSuiteRoots(sourceTree, ["1"]);
    expect(collectIncludedSuites(sourceTree, normalized.roots).map((suite) => suite.id)).toEqual(["1", "2"]);
  });

  it("deduplicates selections and drops descendants already covered by a root", () => {
    const result = normalizeSelectedSuiteRoots(sourceTree, ["1", "1", "2", "404"]);
    expect(result.roots.map((root) => root.id)).toEqual(["1"]);
    expect(result.missingSuiteIds).toEqual(["404"]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["duplicate-selection", "parent-child-overlap"]),
    );
  });

  it("plans recursive targets and resolves sibling name conflicts", () => {
    const roots = normalizeSelectedSuiteRoots(sourceTree, ["1"]).roots;
    const result = planTargetSuites({
      sourceTree,
      targetTree,
      selectedRoots: roots,
      targetParentSuiteId: "9",
    });
    expect(result.plannedSuites[0]).toMatchObject({ targetSuiteName: "Root - Migrated" });
    expect(result.plannedSuites[1]).toMatchObject({ targetParentSourceSuiteId: "1" });
    expect(result.warnings[0]?.code).toBe("suite-name-conflict");
  });

  it.each([
    ["not executed", "notExecuted"],
    ["IN_PROGRESS", "inProgress"],
    ["passed", "passed"],
    ["unknown", undefined],
  ])("normalizes outcome %s", (input, expected) => {
    expect(normalizeOutcomeForAzure(input)).toBe(expected);
  });

  it("classifies actionable and existing outcomes", () => {
    expect(hasActionableOutcome({ latestOutcome: "passed" } as never)).toBe(true);
    expect(hasActionableOutcome({ latestOutcome: "not executed" } as never)).toBe(false);
    expect(targetOutcomeExists("failed")).toBe(true);
    expect(outcomeCategory("not applicable")).toBe("Not Applicable");
    expect(pointMatchKey("1", "2", "3")).toBe("1::2::3");
  });

  it("extracts IDs from Azure URLs and rejects cross-project requests", () => {
    expect(azureIdSchema("plan").parse("https://example.test/plans/42/")).toBe("42");
    expect(azureIdSchema("suite").parse("https://example.test?planId=42&suiteId=7")).toBe("7");
    expect(SuiteMigrationRequestSchema.safeParse({
      scope: projectScope(),
      sourceProjectId: "other",
      sourceTestPlanId: "1",
      selectedSuiteIds: ["2"],
      targetProjectId: "azure-project-1",
      targetTestPlanId: "3",
      targetParentSuiteId: "4",
    }).success).toBe(false);
  });
});
