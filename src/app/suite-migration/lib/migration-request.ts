import type { ActiveProjectScope } from "@/shared/lib/active-project";
import type {
  OutcomeMigrationMode,
  SuiteMigrationOperationMode,
  TestSuiteMigrationRequest,
} from "@/types/test-suite-migration";

export type MigrationRequestState = {
  sourcePlanId: string;
  targetPlanId: string;
  selectedSuiteIds: string[];
  targetParentSuiteId: string;
  operationMode: SuiteMigrationOperationMode;
  outcomeMode: OutcomeMigrationMode;
  overwriteTargetOutcomes: boolean;
};

export function buildMigrationRequest(
  scope: ActiveProjectScope | null,
  state: MigrationRequestState,
): TestSuiteMigrationRequest | null {
  if (!scope) return null;
  return {
    scope,
    sourceProjectId: scope.azureProjectId,
    sourceTestPlanId: state.sourcePlanId,
    selectedSuiteIds: state.selectedSuiteIds,
    targetProjectId: scope.azureProjectId,
    targetTestPlanId: state.targetPlanId,
    targetParentSuiteId: state.targetParentSuiteId,
    operationMode: state.operationMode,
    outcomeMode: state.outcomeMode,
    overwriteTargetOutcomes: state.overwriteTargetOutcomes,
    conflictStrategy: "renameWithMigratedSuffix",
  };
}

export function migrationPreviewState(input: {
  scope: ActiveProjectScope | null;
  sourcePlanId: string;
  targetPlanId: string;
  targetParentSuiteId: string;
  selectedSuiteIds: readonly string[];
  sourceTreeLoading: boolean;
  targetTreeLoading: boolean;
  previewLoading: boolean;
}) {
  const blockReason = !input.scope
    ? "Select an Azure DevOps project"
    : !input.sourcePlanId
      ? "Select a source test plan"
      : !input.selectedSuiteIds.length
        ? "Select at least one source suite"
        : !input.targetPlanId
          ? "Select a target test plan"
          : !input.targetParentSuiteId
            ? "Choose a target parent suite"
            : null;
  return {
    blockReason,
    canPreview: Boolean(
      !blockReason &&
      !input.sourceTreeLoading &&
      !input.targetTreeLoading &&
      !input.previewLoading
    ),
  };
}

export function canExecuteMigration(previewErrorCount: number | null, loading: boolean) {
  return previewErrorCount !== null && previewErrorCount === 0 && !loading;
}

export type SuiteTreeRefreshPlan = "none" | "source" | "target" | "both" | "shared";

export function planSuiteTreeRefresh(input: {
  suitesCreated: number;
  sourceSuitesDeleted: number;
  request: Pick<TestSuiteMigrationRequest, "sourceTestPlanId" | "targetTestPlanId">;
  currentSourcePlanId: string;
  currentTargetPlanId: string;
}): SuiteTreeRefreshPlan {
  const affected = new Set<string>();
  if (input.suitesCreated > 0) affected.add(input.request.targetTestPlanId);
  if (input.sourceSuitesDeleted > 0) affected.add(input.request.sourceTestPlanId);
  const refreshSource = affected.has(input.currentSourcePlanId);
  const refreshTarget = affected.has(input.currentTargetPlanId);
  if (!refreshSource && !refreshTarget) return "none";
  if (refreshSource && refreshTarget && input.currentSourcePlanId === input.currentTargetPlanId) {
    return "shared";
  }
  if (refreshSource && refreshTarget) return "both";
  return refreshSource ? "source" : "target";
}

export function formatMigrationLabel(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatMigrationDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}
