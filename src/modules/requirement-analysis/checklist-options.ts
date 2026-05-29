export const requirementAnalysisChecklistItemIdValues = [
  "completeness_testability",
  "ambiguity_clarity",
  "conflict_source_of_truth",
  "workflow_state_preconditions",
  "business_rules_configuration",
  "integration_api_dependency",
  "data_validation_formula_persistence",
  "timing_performance_concurrency",
  "error_empty_offline_recovery",
  "ui_ux_interaction",
  "localization_rtl_ltr",
  "responsive_layout_stability",
  "accessibility",
  "security_privacy_compliance",
  "auditability_observability_supportability",
  "impact_risk_assessment",
] as const;

export type RequirementAnalysisChecklistItemId = (typeof requirementAnalysisChecklistItemIdValues)[number];

export const requirementAnalysisChecklistOptions: Array<{
  id: RequirementAnalysisChecklistItemId;
  title: string;
}> = [
  { id: "completeness_testability", title: "Requirement Completeness and Testability" },
  { id: "ambiguity_clarity", title: "Ambiguity and Clarity" },
  { id: "conflict_source_of_truth", title: "Conflict and Source of Truth" },
  { id: "workflow_state_preconditions", title: "Workflow, State, and Preconditions" },
  { id: "business_rules_configuration", title: "Business Rules and Configuration" },
  { id: "integration_api_dependency", title: "Integration, API, and Dependency Risk" },
  { id: "data_validation_formula_persistence", title: "Data, Validation, Formula, and Persistence" },
  { id: "timing_performance_concurrency", title: "Timing, Performance, Progressive Loading, and Concurrency" },
  { id: "error_empty_offline_recovery", title: "Error, Empty, Offline, and Recovery States" },
  { id: "ui_ux_interaction", title: "UI, UX, and Interaction Behavior" },
  { id: "localization_rtl_ltr", title: "Localization, Language Consistency, and RTL/LTR Behavior" },
  { id: "responsive_layout_stability", title: "Responsive Layout and UI Stability" },
  { id: "accessibility", title: "Accessibility" },
  { id: "security_privacy_compliance", title: "Security, Privacy, and Compliance" },
  { id: "auditability_observability_supportability", title: "Auditability, Observability, and Supportability" },
  { id: "impact_risk_assessment", title: "Impact and Risk Assessment" },
];

export const allRequirementAnalysisChecklistItemIds = [...requirementAnalysisChecklistItemIdValues];
