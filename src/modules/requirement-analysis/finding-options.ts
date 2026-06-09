export const requirementIssueTypeValues = [
  "ambiguity",
  "conflict",
  "missing_requirement",
  "incomplete_criteria",
  "inconsistency",
  "non_testable_requirement",
  "unsupported_assumption",
  "unhandled_edge_case",
  "ownership_gap",
  "traceability_gap",
  "risk_gap",
] as const;

export const requirementFindingSeverityValues = ["critical", "high", "medium", "low", "info"] as const;

export const requirementRiskLevelValues = ["high", "medium", "low"] as const;

export type RequirementIssueType = (typeof requirementIssueTypeValues)[number];
export type RequirementFindingSeverity = (typeof requirementFindingSeverityValues)[number];
export type RequirementRiskLevel = (typeof requirementRiskLevelValues)[number];
