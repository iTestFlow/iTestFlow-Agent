export const targetTestCaseRangeIdValues = [
  "quick_confidence",
  "standard_risk_based",
  "extended_regression",
  "full_functional_coverage",
  "custom",
] as const;

export type TargetTestCaseRangeId = (typeof targetTestCaseRangeIdValues)[number];

export type TargetTestCaseRangeOption = {
  id: TargetTestCaseRangeId;
  label: string;
  minCases: number;
  maxCases: number;
};

export const targetTestCaseRangeOptions: TargetTestCaseRangeOption[] = [
  { id: "quick_confidence", label: "Quick Confidence", minCases: 3, maxCases: 7 },
  { id: "standard_risk_based", label: "Standard Risk-Based", minCases: 8, maxCases: 15 },
  { id: "extended_regression", label: "Extended Regression", minCases: 15, maxCases: 30 },
  { id: "full_functional_coverage", label: "Full Functional Coverage", minCases: 25, maxCases: 50 },
  { id: "custom", label: "Custom", minCases: 15, maxCases: 30 },
];

export const defaultTargetTestCaseRangeId: TargetTestCaseRangeId = "extended_regression";
export const maxCustomTestCaseRange = 50;

export const coverageFocusIdValues = [
  "functional",
  "regression_impact",
  "integration_api",
  "security_permissions",
  "data_validation",
  "edge_negative",
  "ui_interaction",
  "responsive_layout",
  "localization_language_rtl_ltr",
  "accessibility",
] as const;

export type CoverageFocusId = (typeof coverageFocusIdValues)[number];

export type CoverageFocusOption = {
  id: CoverageFocusId;
  title: string;
};

export const coverageFocusOptions: CoverageFocusOption[] = [
  { id: "functional", title: "Functional" },
  { id: "regression_impact", title: "Regression Impact" },
  { id: "integration_api", title: "Integration / API" },
  { id: "security_permissions", title: "Security / Permissions" },
  { id: "data_validation", title: "Data Validation" },
  { id: "edge_negative", title: "Edge Cases / Negative Scenarios" },
  { id: "ui_interaction", title: "UI Interaction Behavior" },
  { id: "responsive_layout", title: "Responsive Layout" },
  { id: "localization_language_rtl_ltr", title: "Localization, Language, and RTL/LTR" },
  { id: "accessibility", title: "Accessibility" },
];

export const allCoverageFocusIds = [...coverageFocusIdValues];

export type TestDesignOptions = {
  targetTestCaseRange: TargetTestCaseRangeId;
  customMinCases?: number;
  customMaxCases?: number;
  coverageFocusIds: CoverageFocusId[];
};

export const defaultTestDesignOptions: TestDesignOptions = {
  targetTestCaseRange: defaultTargetTestCaseRangeId,
  coverageFocusIds: [...allCoverageFocusIds],
};

export type NormalizedTestDesignOptions = {
  targetTestCaseRange: TargetTestCaseRangeId;
  targetTestCaseRangeLabel: string;
  minCases: number;
  maxCases: number;
  coverageFocusIds: CoverageFocusId[];
  coverageFocusLabels: string[];
};

const targetTestCaseRangeOptionById = new Map(targetTestCaseRangeOptions.map((option) => [option.id, option]));
const coverageFocusOptionById = new Map(coverageFocusOptions.map((option) => [option.id, option]));

export function normalizeTestDesignOptions(options?: Partial<TestDesignOptions> | null): NormalizedTestDesignOptions {
  const targetTestCaseRange = isTargetTestCaseRangeId(options?.targetTestCaseRange)
    ? options.targetTestCaseRange
    : defaultTargetTestCaseRangeId;
  const targetRangeOption =
    targetTestCaseRangeOptionById.get(targetTestCaseRange) ?? targetTestCaseRangeOptionById.get(defaultTargetTestCaseRangeId)!;
  const customMinCases = clampInteger(options?.customMinCases, 1, maxCustomTestCaseRange);
  const customMaxCases = clampInteger(options?.customMaxCases, 1, maxCustomTestCaseRange);
  const minCases = targetTestCaseRange === "custom" ? customMinCases ?? targetRangeOption.minCases : targetRangeOption.minCases;
  const maxCases = targetTestCaseRange === "custom" ? customMaxCases ?? targetRangeOption.maxCases : targetRangeOption.maxCases;
  const orderedCoverageFocusIds = Array.isArray(options?.coverageFocusIds)
    ? allCoverageFocusIds.filter((id) => options.coverageFocusIds?.includes(id))
    : [...allCoverageFocusIds];

  return {
    targetTestCaseRange,
    targetTestCaseRangeLabel: targetRangeOption.label,
    minCases,
    maxCases,
    coverageFocusIds: orderedCoverageFocusIds,
    coverageFocusLabels: orderedCoverageFocusIds.map((id) => coverageFocusOptionById.get(id)?.title ?? id),
  };
}

export function isTargetTestCaseRangeId(value: unknown): value is TargetTestCaseRangeId {
  return typeof value === "string" && targetTestCaseRangeIdValues.includes(value as TargetTestCaseRangeId);
}

function clampInteger(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return Math.min(Math.max(value, min), max);
}
