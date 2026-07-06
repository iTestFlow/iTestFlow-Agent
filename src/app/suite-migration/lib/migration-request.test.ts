import { describe, expect, it } from "vitest";

import type { ActiveProjectScope } from "@/shared/lib/active-project";
import {
  buildMigrationRequest,
  canExecuteMigration,
  formatMigrationDate,
  formatMigrationLabel,
  migrationPreviewState,
  planSuiteTreeRefresh,
} from "./migration-request";

const scope: ActiveProjectScope = {
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Demo",
  azureOrganizationUrl: "https://dev.azure.com/demo",
  workspaceId: "ws-1",
};
const state = {
  sourcePlanId: "plan-source",
  targetPlanId: "plan-target",
  selectedSuiteIds: ["suite-1"],
  targetParentSuiteId: "suite-parent",
  operationMode: "copy" as const,
  outcomeMode: "latestOutcome" as const,
  overwriteTargetOutcomes: true,
};

describe("migration request helpers", () => {
  it("builds a server request from the trusted active project scope", () => {
    expect(buildMigrationRequest(scope, state)).toEqual({
      scope,
      sourceProjectId: "azure-project-1",
      sourceTestPlanId: "plan-source",
      selectedSuiteIds: ["suite-1"],
      targetProjectId: "azure-project-1",
      targetTestPlanId: "plan-target",
      targetParentSuiteId: "suite-parent",
      operationMode: "copy",
      outcomeMode: "latestOutcome",
      overwriteTargetOutcomes: true,
      conflictStrategy: "renameWithMigratedSuffix",
    });
  });

  it("does not build a request without an active project", () => {
    expect(buildMigrationRequest(null, state)).toBeNull();
  });

  it.each([
    [{ scope: null }, "Select an Azure DevOps project"],
    [{ sourcePlanId: "" }, "Select a source test plan"],
    [{ selectedSuiteIds: [] }, "Select at least one source suite"],
    [{ targetPlanId: "" }, "Select a target test plan"],
    [{ targetParentSuiteId: "" }, "Choose a target parent suite"],
  ])("explains each incomplete preview state", (override, reason) => {
    expect(migrationPreviewState({
      scope,
      sourcePlanId: "source",
      targetPlanId: "target",
      targetParentSuiteId: "parent",
      selectedSuiteIds: ["suite"],
      sourceTreeLoading: false,
      targetTreeLoading: false,
      previewLoading: false,
      ...override,
    })).toEqual({ canPreview: false, blockReason: reason });
  });

  it("blocks preview during loading without inventing a validation reason", () => {
    expect(migrationPreviewState({
      scope,
      sourcePlanId: "source",
      targetPlanId: "target",
      targetParentSuiteId: "parent",
      selectedSuiteIds: ["suite"],
      sourceTreeLoading: true,
      targetTreeLoading: false,
      previewLoading: false,
    })).toEqual({ canPreview: false, blockReason: null });
  });

  it("allows execution only for an error-free preview while idle", () => {
    expect(canExecuteMigration(null, false)).toBe(false);
    expect(canExecuteMigration(1, false)).toBe(false);
    expect(canExecuteMigration(0, true)).toBe(false);
    expect(canExecuteMigration(0, false)).toBe(true);
  });

  it.each([
    [{ suitesCreated: 0, sourceSuitesDeleted: 0 }, "none"],
    [{ suitesCreated: 1, sourceSuitesDeleted: 0 }, "target"],
    [{ suitesCreated: 0, sourceSuitesDeleted: 1 }, "source"],
    [{ suitesCreated: 1, sourceSuitesDeleted: 1 }, "both"],
  ] as const)("plans affected source and target refreshes", (summary, expected) => {
    expect(planSuiteTreeRefresh({
      ...summary,
      request: { sourceTestPlanId: "source", targetTestPlanId: "target" },
      currentSourcePlanId: "source",
      currentTargetPlanId: "target",
    })).toBe(expected);
  });

  it("collapses refreshes to one shared load when both selectors show the same plan", () => {
    expect(planSuiteTreeRefresh({
      suitesCreated: 1,
      sourceSuitesDeleted: 1,
      request: { sourceTestPlanId: "same", targetTestPlanId: "same" },
      currentSourcePlanId: "same",
      currentTargetPlanId: "same",
    })).toBe("shared");
  });

  it("formats camel-case labels and missing dates for the report UI", () => {
    expect(formatMigrationLabel("partiallyCompleted")).toBe("Partially Completed");
    expect(formatMigrationDate()).toBe("-");
  });
});
