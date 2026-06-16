export const workflowTypeValues = [
  "requirements_analysis",
  "test_case_design",
  "test_gap_analysis",
  "report_bug",
  "test_execution_effort",
  "suite_migration",
  "bulk_task_creation",
  "knowledge_indexing",
  "business_owner_assistant",
] as const;

export type WorkflowType = (typeof workflowTypeValues)[number];

// Workflows with an explicit select/publish step, where an "acceptance rate"
// (accepted vs generated) is meaningful. Conversational/estimation/indexing workflows
// (business_owner_assistant, test_execution_effort, knowledge_indexing) generate output
// with no accept step, so including them would systematically drag the rate toward 0.
export const PUBLISH_WORKFLOW_TYPES: readonly WorkflowType[] = [
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
  test_execution_effort: "Test Execution Effort",
  suite_migration: "Suite Migration",
  bulk_task_creation: "Bulk Task Creation",
  knowledge_indexing: "Knowledge Indexing",
  business_owner_assistant: "Business Owner Assistant",
};

export const defaultWorkflowBaselines: Record<WorkflowType, number> = {
  requirements_analysis: 45,
  test_case_design: 90,
  test_gap_analysis: 75,
  report_bug: 20,
  test_execution_effort: 30,
  suite_migration: 180,
  bulk_task_creation: 60,
  knowledge_indexing: 30,
  business_owner_assistant: 30,
};
