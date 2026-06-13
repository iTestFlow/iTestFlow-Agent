import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { AzureTestPoint, TestSuiteType } from "@/modules/integrations/azure-devops/azure-devops-types";
import { assertProjectScope } from "@/modules/projects/project-isolation.guard";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import type {
  MigrationAction,
  MigrationError,
  MigrationPreview,
  MigrationPreviewRow,
  MigrationReport,
  MigrationResult,
  MigrationWarning,
  RecursiveSuiteMigrationNode,
  SourceTestPointSnapshot,
  SuiteTreeNode,
  TargetSuiteMapping,
  TestSuiteMigrationRequest,
} from "@/types/test-suite-migration";
import {
  collectIncludedSuites,
  findSuiteNode,
  hasActionableOutcome,
  normalizeOutcomeForAzure,
  normalizeSelectedSuiteRoots,
  outcomeCategory,
  planTargetSuites,
  pointMatchKey,
  targetOutcomeExists,
  toSuiteTreeNodes,
} from "./test-suite-migration.logic";

type MigrationPlan = {
  preview: MigrationPreview;
  sourceTree: SuiteTreeNode[];
  targetTree: SuiteTreeNode[];
  includedSuites: SuiteTreeNode[];
  sourcePoints: SourceTestPointSnapshot[];
};

export async function loadMigrationSuiteTree(
  adapter: AzureDevOpsAdapter,
  input: { projectId: string; testPlanId: string },
) {
  const suites = await adapter.fetchTestSuiteTree(input);
  return toSuiteTreeNodes(suites);
}

export async function buildMigrationPreview(adapter: AzureDevOpsAdapter, request: TestSuiteMigrationRequest): Promise<MigrationPreview> {
  return (await buildMigrationPlan(adapter, request)).preview;
}

export async function executeSuiteMigration(adapter: AzureDevOpsAdapter, request: TestSuiteMigrationRequest): Promise<MigrationResult> {
  const plan = await buildMigrationPlan(adapter, request);
  const blockingErrors = plan.preview.errors.filter((error) => error.code !== "point-read-failed");
  if (blockingErrors.length) {
    throw new Error(blockingErrors[0]?.message ?? "Migration preview contains blocking errors.");
  }

  const scope = assertProjectScope(request.scope);
  const actions: MigrationAction[] = [];
  const warnings: MigrationWarning[] = [...plan.preview.warnings];
  const errors: MigrationError[] = [];
  const suiteMappings: TargetSuiteMapping[] = [];
  const suiteMappingBySourceId = new Map<string, TargetSuiteMapping>();

  for (const plannedSuite of plan.preview.plannedSuites) {
    const parentSuiteId = plannedSuite.targetParentSourceSuiteId
      ? suiteMappingBySourceId.get(plannedSuite.targetParentSourceSuiteId)?.targetSuiteId
      : request.targetParentSuiteId;

    if (!parentSuiteId) {
      const message = `Skipped ${plannedSuite.sourceSuitePath} because its target parent was not created.`;
      actions.push({ action: "createSuite", status: "skipped", sourceSuiteId: plannedSuite.sourceSuiteId, message });
      errors.push({ code: "target-parent-missing", suiteId: plannedSuite.sourceSuiteId, message });
      continue;
    }

    const created = await createTargetSuiteWithFallback(adapter, request, plannedSuite, parentSuiteId, warnings);
    if (!created.success || !created.suiteId) {
      const message = sanitizeAzureError(created.error ?? `Failed to create target suite for ${plannedSuite.sourceSuitePath}.`);
      actions.push({ action: "createSuite", status: "failed", sourceSuiteId: plannedSuite.sourceSuiteId, message });
      errors.push({ code: "suite-create-failed", suiteId: plannedSuite.sourceSuiteId, message });
      continue;
    }

    actions.push({
      action: "createSuite",
      status: "success",
      sourceSuiteId: plannedSuite.sourceSuiteId,
      targetSuiteId: created.suiteId,
      message: `Created ${plannedSuite.targetSuitePath}.`,
    });

    const mapping = {
      sourceSuiteId: plannedSuite.sourceSuiteId,
      sourceSuitePath: plannedSuite.sourceSuitePath,
      targetSuiteId: created.suiteId,
      targetSuitePath: plannedSuite.targetSuitePath,
      targetSuiteName: created.suiteName ?? plannedSuite.targetSuiteName,
    };
    suiteMappings.push(mapping);
    suiteMappingBySourceId.set(plannedSuite.sourceSuiteId, mapping);
  }

  const pointsBySourceSuite = groupSourcePointsBySuite(plan.sourcePoints);
  for (const mapping of suiteMappings) {
    const directPoints = pointsBySourceSuite.get(mapping.sourceSuiteId) ?? [];
    const suiteTestCases = toSuiteTestCases(directPoints);
    if (!suiteTestCases.length) continue;

    const addResult = await adapter.addTestCasesToSuite({
      projectId: request.targetProjectId,
      testPlanId: request.targetTestPlanId,
      testSuiteId: mapping.targetSuiteId,
      testCases: suiteTestCases,
    });

    actions.push({
      action: "addTestCase",
      status: addResult.success ? "success" : "failed",
      sourceSuiteId: mapping.sourceSuiteId,
      targetSuiteId: mapping.targetSuiteId,
      message: `Added ${addResult.addedCount} of ${suiteTestCases.length} test case associations to ${mapping.targetSuitePath}.`,
    });
    addResult.errors.forEach((error) => {
      errors.push({
        code: "test-case-add-failed",
        suiteId: mapping.sourceSuiteId,
        testCaseId: error.testCaseId,
        message: sanitizeAzureError(error.error),
      });
    });
  }

  const targetPointsBySuite = new Map<string, AzureTestPoint[]>();
  for (const mapping of suiteMappings) {
    const expectedCount = pointsBySourceSuite.get(mapping.sourceSuiteId)?.length ?? 0;
    const points = await fetchTargetPointsWithRetry(adapter, {
      projectId: request.targetProjectId,
      testPlanId: request.targetTestPlanId,
      testSuiteId: mapping.targetSuiteId,
      expectedCount,
    });
    targetPointsBySuite.set(mapping.sourceSuiteId, points);
  }

  if (request.outcomeMode === "none") {
    actions.push({
      action: "skipOutcome",
      status: "skipped",
      message: "Outcome migration was disabled by the selected mode.",
    });
  } else {
    for (const sourcePoint of plan.sourcePoints) {
      const mapping = suiteMappingBySourceId.get(sourcePoint.sourceSuiteId);
      if (!mapping) continue;
      const normalizedOutcome = normalizeOutcomeForAzure(sourcePoint.latestOutcome);
      if (!hasActionableOutcome(sourcePoint)) {
        actions.push({
          action: "skipOutcome",
          status: "skipped",
          sourceSuiteId: sourcePoint.sourceSuiteId,
          sourcePointId: sourcePoint.id,
          testCaseId: sourcePoint.testCaseId,
          message: "Skipped because the source point has no latest executable outcome.",
        });
        continue;
      }
      if (!sourcePoint.testCaseId || !sourcePoint.configurationId) {
        const message = "Cannot map source point because test case or configuration is missing.";
        actions.push({
          action: "updateOutcome",
          status: "failed",
          sourceSuiteId: sourcePoint.sourceSuiteId,
          sourcePointId: sourcePoint.id,
          testCaseId: sourcePoint.testCaseId,
          message,
        });
        errors.push({ code: "source-point-key-missing", suiteId: sourcePoint.sourceSuiteId, pointId: sourcePoint.id, message });
        continue;
      }

      const targetPoints = targetPointsBySuite.get(sourcePoint.sourceSuiteId) ?? [];
      const targetPoint = targetPoints.find(
        (point) => pointMatchKey(mapping.targetSuiteId, point.testCaseId, point.configurationId) === pointMatchKey(mapping.targetSuiteId, sourcePoint.testCaseId, sourcePoint.configurationId),
      );
      if (!targetPoint) {
        const message = "No matching target test point was created.";
        actions.push({
          action: "updateOutcome",
          status: "failed",
          sourceSuiteId: sourcePoint.sourceSuiteId,
          sourcePointId: sourcePoint.id,
          testCaseId: sourcePoint.testCaseId,
          message,
        });
        errors.push({ code: "target-point-unmapped", suiteId: sourcePoint.sourceSuiteId, testCaseId: sourcePoint.testCaseId, pointId: sourcePoint.id, message });
        continue;
      }

      if (targetOutcomeExists(targetPoint.outcome) && !request.overwriteTargetOutcomes) {
        actions.push({
          action: "skipOutcome",
          status: "skipped",
          sourceSuiteId: sourcePoint.sourceSuiteId,
          targetSuiteId: mapping.targetSuiteId,
          sourcePointId: sourcePoint.id,
          targetPointId: targetPoint.id,
          testCaseId: sourcePoint.testCaseId,
          message: "Skipped because the target point already has an outcome and overwrite is disabled.",
        });
        continue;
      }

      if (!normalizedOutcome) {
        const message = `Unsupported source outcome "${sourcePoint.latestOutcome}".`;
        actions.push({
          action: "updateOutcome",
          status: "failed",
          sourceSuiteId: sourcePoint.sourceSuiteId,
          sourcePointId: sourcePoint.id,
          targetPointId: targetPoint.id,
          testCaseId: sourcePoint.testCaseId,
          message,
        });
        errors.push({ code: "unsupported-outcome", suiteId: sourcePoint.sourceSuiteId, testCaseId: sourcePoint.testCaseId, pointId: sourcePoint.id, message });
        continue;
      }

      const update = await adapter.updateTestPoints({
        projectId: request.targetProjectId,
        testPlanId: request.targetTestPlanId,
        testSuiteId: mapping.targetSuiteId,
        pointIds: [targetPoint.id],
        outcome: normalizedOutcome,
      });
      actions.push({
        action: "updateOutcome",
        status: update.success ? "success" : "failed",
        sourceSuiteId: sourcePoint.sourceSuiteId,
        targetSuiteId: mapping.targetSuiteId,
        sourcePointId: sourcePoint.id,
        targetPointId: targetPoint.id,
        testCaseId: sourcePoint.testCaseId,
        message: update.success ? `Applied ${outcomeCategory(normalizedOutcome)} to target point ${targetPoint.id}.` : sanitizeAzureError(update.error ?? "Test point update failed."),
      });
      if (!update.success) {
        errors.push({
          code: "outcome-update-failed",
          suiteId: sourcePoint.sourceSuiteId,
          testCaseId: sourcePoint.testCaseId,
          pointId: sourcePoint.id,
          message: sanitizeAzureError(update.error ?? "Test point update failed."),
        });
      }
    }
  }

  const criticalFailure = errors.length > 0 || actions.some((action) => action.status === "failed" && action.action !== "deleteSourceSuite");
  if (request.operationMode === "move") {
    if (criticalFailure) {
      warnings.push({
        code: "move-source-delete-blocked",
        severity: "warning",
        message: "Source suites were not deleted because migration had critical failures.",
      });
    } else {
      for (const root of plan.preview.selectedRoots) {
        const deleted = await adapter.deleteTestSuite({
          projectId: request.sourceProjectId,
          testPlanId: request.sourceTestPlanId,
          testSuiteId: root.id,
        });
        actions.push({
          action: "deleteSourceSuite",
          status: deleted.success ? "success" : "failed",
          sourceSuiteId: root.id,
          message: deleted.success ? `Deleted source root suite ${root.path}.` : sanitizeAzureError(deleted.error ?? "Source suite deletion failed."),
        });
        if (!deleted.success) {
          errors.push({ code: "source-delete-failed", suiteId: root.id, message: sanitizeAzureError(deleted.error ?? "Source suite deletion failed.") });
        }
      }
    }
  }

  const report = buildReport(request, suiteMappings, actions, warnings, errors);
  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    entityType: "test_suite",
    entityId: plan.preview.selectedRoots.map((root) => root.id).join(","),
    action: "azure_devops.test_suite_migration",
    status: report.status === "completed" ? "Success" : report.status === "partiallyCompleted" ? "Partial failure" : "Failed",
    message: `Migrated ${report.summary.suitesCreated} suite(s), updated ${report.summary.outcomesUpdated} outcome(s).`,
    details: report,
  });

  return { preview: plan.preview, report };
}

async function buildMigrationPlan(adapter: AzureDevOpsAdapter, request: TestSuiteMigrationRequest): Promise<MigrationPlan> {
  const scope = assertProjectScope(request.scope);
  const warnings: MigrationWarning[] = [];
  const errors: MigrationError[] = [];

  if (request.sourceProjectId !== scope.azureProjectId || request.targetProjectId !== scope.azureProjectId) {
    errors.push({
      code: "project-scope-mismatch",
      message: "Source and target suites must be in the selected Azure DevOps project.",
    });
  }

  const [sourceTreeRaw, targetTreeRaw] = await Promise.all([
    adapter.fetchTestSuiteTree({ projectId: request.sourceProjectId, testPlanId: request.sourceTestPlanId }),
    adapter.fetchTestSuiteTree({ projectId: request.targetProjectId, testPlanId: request.targetTestPlanId }),
  ]);
  const sourceTree = toSuiteTreeNodes(sourceTreeRaw);
  const targetTree = toSuiteTreeNodes(targetTreeRaw);
  const normalized = normalizeSelectedSuiteRoots(sourceTree, request.selectedSuiteIds);
  warnings.push(...normalized.warnings);
  normalized.missingSuiteIds.forEach((suiteId) => {
    errors.push({ code: "selected-suite-not-found", suiteId, message: `Selected suite ${suiteId} was not found in the source test plan.` });
  });
  if (!normalized.roots.length) {
    errors.push({ code: "no-suite-selected", message: "Select at least one source suite before previewing migration." });
  }
  const targetParent = findSuiteNode(targetTree, request.targetParentSuiteId);
  if (!targetParent) {
    errors.push({
      code: "target-parent-not-found",
      suiteId: request.targetParentSuiteId,
      message: `Target parent suite ${request.targetParentSuiteId} was not found in the target test plan.`,
    });
  } else if (targetParent.suiteType !== "staticTestSuite") {
    errors.push({
      code: "target-parent-not-static",
      suiteId: request.targetParentSuiteId,
      message: "Only static suites can be selected as a target parent.",
    });
  }

  const includedSuites = collectIncludedSuites(sourceTree, normalized.roots);
  if (request.sourceTestPlanId === request.targetTestPlanId && includedSuites.some((suite) => suite.id === request.targetParentSuiteId)) {
    errors.push({
      code: "target-inside-source",
      suiteId: request.targetParentSuiteId,
      message: "Target parent suite cannot be one of the selected source suites or their descendants.",
    });
  }

  const planned = planTargetSuites({
    sourceTree,
    targetTree,
    selectedRoots: normalized.roots,
    targetParentSuiteId: request.targetParentSuiteId,
  });
  warnings.push(...planned.warnings);

  const sourcePoints: SourceTestPointSnapshot[] = [];
  for (const suite of includedSuites) {
    try {
      const points = await adapter.fetchTestPoints({
        projectId: request.sourceProjectId,
        testPlanId: request.sourceTestPlanId,
        testSuiteId: suite.id,
      });
      sourcePoints.push(...points.map((point) => toSourcePointSnapshot(point, suite)));
    } catch (error) {
      const message = sanitizeAzureError(error instanceof Error ? error.message : "Azure DevOps test point read failed.");
      errors.push({ code: "point-read-failed", suiteId: suite.id, message });
    }
  }

  const plannedBySourceSuite = new Map(planned.plannedSuites.map((suite) => [suite.sourceSuiteId, suite]));
  const rows = buildPreviewRows(sourcePoints, normalized.roots, plannedBySourceSuite, request, warnings, errors);
  const outcomeBreakdown = buildOutcomeBreakdown(sourcePoints);
  const uniqueTestCases = new Set(sourcePoints.map((point) => point.testCaseId).filter(Boolean));
  const mappableOutcomeCount = sourcePoints.filter((point) => hasActionableOutcome(point) && point.testCaseId && point.configurationId).length;
  const unmappedTestPointCount = sourcePoints.filter((point) => !point.testCaseId || !point.configurationId).length;

  const preview: MigrationPreview = {
    status: errors.length ? "failed" : "readyToMigrate",
    sourceProjectId: request.sourceProjectId,
    sourceTestPlanId: request.sourceTestPlanId,
    targetProjectId: request.targetProjectId,
    targetTestPlanId: request.targetTestPlanId,
    targetParentSuiteId: request.targetParentSuiteId,
    selectedRootSuiteCount: normalized.roots.length,
    totalSuiteCount: includedSuites.length,
    childSuitesIncludedCount: Math.max(0, includedSuites.length - normalized.roots.length),
    totalSourceTestCaseCount: uniqueTestCases.size,
    totalSourceTestPointCount: sourcePoints.length,
    expectedTargetSuiteCount: planned.plannedSuites.length,
    expectedTargetTestPointCount: sourcePoints.length,
    mappableOutcomeCount,
    unmappedTestPointCount,
    targetPointsWithExistingOutcomes: 0,
    skippedBecauseOverwriteDisabled: 0,
    overwrittenIfEnabled: 0,
    outcomeBreakdown,
    selectedRoots: normalized.roots,
    plannedSuites: planned.plannedSuites,
    warnings,
    errors,
    rows,
    generatedAt: new Date().toISOString(),
  };

  return { preview, sourceTree, targetTree, includedSuites, sourcePoints };
}

function toSourcePointSnapshot(point: AzureTestPoint, suite: SuiteTreeNode): SourceTestPointSnapshot {
  return {
    id: point.id,
    sourceSuiteId: suite.id,
    sourceSuitePath: suite.path,
    testCaseId: point.testCaseId,
    testCaseTitle: point.testCaseTitle,
    configurationId: point.configurationId,
    configurationName: point.configurationName,
    latestOutcome: point.outcome,
    latestOutcomeCategory: outcomeCategory(point.outcome),
    lastRunDate: point.lastRunDate,
    lastUpdatedDate: point.lastUpdatedDate,
  };
}

function buildPreviewRows(
  points: SourceTestPointSnapshot[],
  roots: Array<{ name: string; path: string }>,
  plannedBySourceSuite: Map<string, RecursiveSuiteMigrationNode>,
  request: TestSuiteMigrationRequest,
  warnings: MigrationWarning[],
  errors: MigrationError[],
): MigrationPreviewRow[] {
  const issueMessagesBySuiteId = buildIssueMessagesBySuiteId(warnings, errors);
  return points.map((point) => {
    const plannedSuite = plannedBySourceSuite.get(point.sourceSuiteId);
    const root = roots.find((candidate) => point.sourceSuitePath === candidate.path || point.sourceSuitePath.startsWith(`${candidate.path} / `));
    const hasRequiredKey = Boolean(point.testCaseId && point.configurationId);
    const actionableOutcome = hasActionableOutcome(point);
    const pointWarningOrError = !hasRequiredKey
      ? "Missing test case or configuration ID."
      : !actionableOutcome
        ? "No source outcome to migrate."
        : undefined;
    const suiteIssueMessages = issueMessagesBySuiteId.get(point.sourceSuiteId) ?? [];
    const warningOrError = [pointWarningOrError, ...suiteIssueMessages].filter(Boolean).join(" ");

    return {
      sourceRootSuite: root?.name ?? point.sourceSuitePath,
      sourceSuitePath: point.sourceSuitePath,
      sourceSuiteId: point.sourceSuiteId,
      sourceTestCaseId: point.testCaseId,
      sourceTestCaseTitle: point.testCaseTitle,
      sourceConfiguration: point.configurationName ?? point.configurationId,
      sourceLatestOutcome: point.latestOutcomeCategory,
      sourceLastRunDate: point.lastRunDate,
      targetSuitePath: plannedSuite?.targetSuitePath ?? "",
      targetTestCaseId: point.testCaseId,
      targetConfiguration: point.configurationName ?? point.configurationId,
      plannedAction: request.outcomeMode === "none" ? "Copy suite/test case only" : actionableOutcome ? "Copy and migrate latest outcome" : "Copy only",
      warningOrError: warningOrError || undefined,
    };
  });
}

function buildIssueMessagesBySuiteId(warnings: MigrationWarning[], errors: MigrationError[]) {
  const messages = new Map<string, string[]>();
  for (const issue of [...warnings, ...errors]) {
    if (!issue.suiteId) continue;
    messages.set(issue.suiteId, [...(messages.get(issue.suiteId) ?? []), issue.message]);
  }
  return messages;
}

function buildOutcomeBreakdown(points: SourceTestPointSnapshot[]) {
  const breakdown: Record<string, number> = {
    Passed: 0,
    Failed: 0,
    Blocked: 0,
    "Not Executed": 0,
    Inconclusive: 0,
    Timeout: 0,
    Aborted: 0,
    Error: 0,
    "Not Applicable": 0,
  };
  points.forEach((point) => {
    const category = point.latestOutcomeCategory;
    breakdown[category] = (breakdown[category] ?? 0) + 1;
  });
  return breakdown;
}

async function createTargetSuiteWithFallback(
  adapter: AzureDevOpsAdapter,
  request: TestSuiteMigrationRequest,
  plannedSuite: RecursiveSuiteMigrationNode,
  parentSuiteId: string,
  warnings: MigrationWarning[],
) {
  const preferredType = preferredTargetSuiteType(plannedSuite);
  const createInput = {
    projectId: request.targetProjectId,
    testPlanId: request.targetTestPlanId,
    parentSuiteId,
    name: plannedSuite.targetSuiteName,
    suiteType: preferredType,
    requirementId: preferredType === "requirementTestSuite" ? plannedSuite.requirementId : undefined,
    queryString: preferredType === "dynamicTestSuite" ? plannedSuite.queryString : undefined,
    inheritDefaultConfigurations: plannedSuite.inheritDefaultConfigurations,
    defaultConfigurations: plannedSuite.defaultConfigurations,
  };
  const result = await adapter.createTestSuite(createInput);
  if (result.success && result.suite) {
    return { success: true, suiteId: result.suite.id, suiteName: result.suite.name };
  }

  if (preferredType !== "staticTestSuite") {
    warnings.push({
      code: "suite-type-fallback",
      severity: "warning",
      suiteId: plannedSuite.sourceSuiteId,
      message: `Could not preserve ${plannedSuite.suiteType}; falling back to a static snapshot for ${plannedSuite.sourceSuitePath}.`,
    });
    const fallback = await adapter.createTestSuite({ ...createInput, suiteType: "staticTestSuite", requirementId: undefined, queryString: undefined });
    if (fallback.success && fallback.suite) {
      return { success: true, suiteId: fallback.suite.id, suiteName: fallback.suite.name };
    }
    return { success: false, error: fallback.error ?? result.error };
  }

  return { success: false, error: result.error };
}

function preferredTargetSuiteType(plannedSuite: RecursiveSuiteMigrationNode): TestSuiteType {
  if (plannedSuite.suiteType === "requirementTestSuite" && plannedSuite.requirementId) return "requirementTestSuite";
  if (plannedSuite.suiteType === "dynamicTestSuite" && plannedSuite.queryString) return "dynamicTestSuite";
  return "staticTestSuite";
}

function groupSourcePointsBySuite(points: SourceTestPointSnapshot[]) {
  const grouped = new Map<string, SourceTestPointSnapshot[]>();
  points.forEach((point) => {
    grouped.set(point.sourceSuiteId, [...(grouped.get(point.sourceSuiteId) ?? []), point]);
  });
  return grouped;
}

function toSuiteTestCases(points: SourceTestPointSnapshot[]) {
  const grouped = new Map<string, Set<string>>();
  points.forEach((point) => {
    if (!point.testCaseId) return;
    const configurations = grouped.get(point.testCaseId) ?? new Set<string>();
    if (point.configurationId) configurations.add(point.configurationId);
    grouped.set(point.testCaseId, configurations);
  });
  return [...grouped.entries()].map(([testCaseId, configurationIds]) => ({
    testCaseId,
    configurationIds: [...configurationIds],
  }));
}

async function fetchTargetPointsWithRetry(
  adapter: AzureDevOpsAdapter,
  input: { projectId: string; testPlanId: string; testSuiteId: string; expectedCount: number },
) {
  let latest: AzureTestPoint[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    latest = await adapter.fetchTestPoints(input);
    if (latest.length >= input.expectedCount || attempt === 2) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return latest;
}

function buildReport(
  request: TestSuiteMigrationRequest,
  suiteMappings: TargetSuiteMapping[],
  actions: MigrationAction[],
  warnings: MigrationWarning[],
  errors: MigrationError[],
): MigrationReport {
  const outcomesUpdated = actions.filter((action) => action.action === "updateOutcome" && action.status === "success").length;
  const outcomesFailed = actions.filter((action) => action.action === "updateOutcome" && action.status === "failed").length;
  const failedActions = actions.filter((action) => action.status === "failed").length;
  const status = failedActions || errors.length ? (actions.some((action) => action.status === "success") ? "partiallyCompleted" : "failed") : "completed";

  return {
    status,
    operationTimestamp: new Date().toISOString(),
    sourceProjectId: request.sourceProjectId,
    sourceTestPlanId: request.sourceTestPlanId,
    targetProjectId: request.targetProjectId,
    targetTestPlanId: request.targetTestPlanId,
    targetParentSuiteId: request.targetParentSuiteId,
    suiteMappings,
    actions,
    warnings,
    errors,
    summary: {
      suitesCreated: actions.filter((action) => action.action === "createSuite" && action.status === "success").length,
      testCasesAdded: actions.filter((action) => action.action === "addTestCase" && action.status === "success").length,
      outcomesUpdated,
      outcomesSkipped: actions.filter((action) => action.action === "skipOutcome").length,
      outcomesFailed,
      sourceSuitesDeleted: actions.filter((action) => action.action === "deleteSourceSuite" && action.status === "success").length,
    },
  };
}
