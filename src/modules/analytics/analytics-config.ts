export const workflowTypeValues = [
  "requirements_analysis",
  "test_case_design",
  "test_gap_analysis",
  "report_bug",
  "suite_migration",
  "bulk_task_creation",
  "knowledge_indexing",
  "business_owner_assistant",
] as const;

export const LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW = "test_execution_effort" as const;
export const reportableWorkflowTypeValues = [
  ...workflowTypeValues,
  LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW,
] as const;

export type ActiveWorkflowType = (typeof workflowTypeValues)[number];
export type WorkflowType = (typeof reportableWorkflowTypeValues)[number];

// Workflows with an explicit select/publish step, where an "acceptance rate"
// (accepted vs generated) is meaningful. Conversational/indexing workflows
// (business_owner_assistant, knowledge_indexing) generate output
// with no accept step, so including them would systematically drag the rate toward 0.
export const PUBLISH_WORKFLOW_TYPES: readonly ActiveWorkflowType[] = [
  "requirements_analysis",
  "test_case_design",
  "test_gap_analysis",
  "report_bug",
  "suite_migration",
  "bulk_task_creation",
];

export const workflowLabels: Record<WorkflowType, string> = {
  requirements_analysis: "Requirements Analysis",
  test_case_design: "Test Case Design",
  test_gap_analysis: "Test Gap Analysis",
  report_bug: "Report Bug",
  suite_migration: "Suite Migration",
  bulk_task_creation: "Bulk Task Creation",
  knowledge_indexing: "Knowledge Indexing",
  business_owner_assistant: "Business Owner Assistant",
  test_execution_effort: "Legacy execution estimate",
};

export const defaultWorkflowBaselines: Record<ActiveWorkflowType, number> = {
  requirements_analysis: 45,
  test_case_design: 90,
  test_gap_analysis: 75,
  report_bug: 20,
  suite_migration: 180,
  bulk_task_creation: 60,
  knowledge_indexing: 30,
  business_owner_assistant: 30,
};

// Workflows whose review effort scales with the number of items the human checks
// (they have an explicit generate→select/publish step), so their review baseline
// is interpreted as minutes-PER-ITEM. All other (conversational/estimation) workflows
// use a flat minutes-PER-RUN review baseline. Mirrors PUBLISH_WORKFLOW_TYPES.
export function isPerItemReview(workflowType: WorkflowType): boolean {
  return PUBLISH_WORKFLOW_TYPES.some((value) => value === workflowType);
}

// Estimated human review/edit effort of the AI output (R). Per-item workflows
// (see isPerItemReview) express minutes-per-item; the rest express minutes-per-run.
// Admin-tunable per workspace via Settings → Value Metrics.
export const defaultReviewBaselines: Record<ActiveWorkflowType, number> = {
  // per-item (minutes to review one generated item)
  requirements_analysis: 4,
  test_case_design: 3,
  test_gap_analysis: 4,
  report_bug: 3,
  suite_migration: 2,
  bulk_task_creation: 2,
  // per-run (flat minutes to review the run's output)
  knowledge_indexing: 2,
  business_owner_assistant: 3,
};

export function getDefaultWorkflowBaseline(workflowType: WorkflowType): number {
  return workflowType === LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW
    ? 30
    : defaultWorkflowBaselines[workflowType];
}

export function getDefaultReviewBaseline(workflowType: WorkflowType): number {
  return workflowType === LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW
    ? 5
    : defaultReviewBaselines[workflowType];
}
