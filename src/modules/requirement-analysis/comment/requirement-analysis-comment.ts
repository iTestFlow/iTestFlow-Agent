import { requirementAnalysisChecklistOptions } from "@/modules/requirement-analysis/checklist-options";
import { formatEnumLabel, formatPercentage } from "@/shared/lib/format";
import type {
  RequirementFinding,
  RequirementSummary,
} from "@/components/workflow/test-intelligence-types";

/**
 * Pure, framework-free builder for the Azure DevOps Requirement Analysis comment.
 *
 * Data derivation is kept separate from Markdown rendering: `derive*` functions
 * turn the existing finding/summary fields into reviewer-facing meaning (delivery
 * impact, owner, evidence level, AC update, test impact) and `build*`/`format*`
 * functions render Markdown that renders cleanly in Azure DevOps comments.
 *
 * No LLM schema change is required — every new field is derived in code from the
 * fields the analysis already produces. The mention line, work-item header, and
 * posting flow are owned by the caller and are intentionally not handled here.
 */

type Severity = RequirementFinding["severity"];
type IssueType = RequirementFinding["issueType"];
type ChecklistItemId = RequirementFinding["checklistItemId"];

export type DeliveryImpact =
  | "Blocking / Must Clarify"
  | "Should Clarify Before UAT"
  | "Improvement / Supportability";

export type EvidenceLevel =
  | "Confirmed from requirement conflict"
  | "Missing from supplied context"
  | "Inferred risk based on incomplete criteria"
  | "Requires PO confirmation"
  | "Confirmed from related requirement/context";

const NOT_APPLICABLE_AC =
  "Not applicable. This should be handled as supporting documentation, implementation guidance, or technical clarification.";

const MAX_TOP_ACTIONS = 5;

/* ----------------------------- small utilities ---------------------------- */

function severitySortRank(severity: Severity): number {
  const ranks: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return ranks[severity] ?? 5;
}

function countBySeverity(findings: RequirementFinding[]) {
  return findings.reduce(
    (counts, finding) => {
      counts.total += 1;
      counts[finding.severity] += 1;
      return counts;
    },
    { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
}

function checklistItemTitle(checklistItemId: ChecklistItemId): string {
  return (
    requirementAnalysisChecklistOptions.find((item) => item.id === checklistItemId)?.title ??
    formatEnumLabel(checklistItemId)
  );
}

function orNotSpecified(value: string): string {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : "Not specified";
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Joins lines with a Markdown hard break (trailing two spaces) without leaving
 *  literal trailing whitespace in source that editors might strip. */
function hardBreakLines(...lines: string[]): string {
  return lines.filter((line) => line.length > 0).join("  \n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function mdTable(header: string[], alignment: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${alignment.join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/* ------------------------------- derivations ------------------------------ */

export function deriveDeliveryImpact(severity: Severity): DeliveryImpact {
  if (severity === "critical" || severity === "high") return "Blocking / Must Clarify";
  if (severity === "medium") return "Should Clarify Before UAT";
  return "Improvement / Supportability";
}

export function deriveSuggestedOwner(finding: RequirementFinding): string {
  // Testability-shaped issues always need QA/Test ownership regardless of area.
  if (finding.issueType === "non_testable_requirement" || finding.issueType === "incomplete_criteria") {
    return "QA / Test Lead / PO";
  }
  switch (finding.checklistItemId) {
    case "completeness_testability":
    case "impact_risk_assessment":
      return "QA / Test Lead / PO";
    case "ambiguity_clarity":
    case "conflict_source_of_truth":
    case "workflow_state_preconditions":
    case "business_rules_configuration":
      return "PO / BA";
    case "integration_api_dependency":
    case "data_validation_formula_persistence":
      return "BA / Backend / Integration Engineer";
    case "ui_ux_interaction":
    case "localization_rtl_ltr":
    case "responsive_layout_stability":
    case "accessibility":
      return "PO / UX / Frontend / QA";
    case "security_privacy_compliance":
      return "Security / Backend / PO";
    case "timing_performance_concurrency":
    case "error_empty_offline_recovery":
    case "auditability_observability_supportability":
      return "Backend / QA / Test Lead";
    default:
      return "PO / BA";
  }
}

export function deriveEvidenceLevel(finding: RequirementFinding): EvidenceLevel {
  // The analysis prompt embeds an internal classification ("Confirmed issue",
  // "Clarification needed", "Testability concern") inside the textual fields, so
  // honor both the structural signals (issueType/contradiction) and that text.
  const classificationText = `${finding.description} ${finding.riskJustification} ${finding.suggestion}`.toLowerCase();

  if (finding.contradiction || finding.issueType === "conflict" || finding.issueType === "inconsistency") {
    return "Confirmed from requirement conflict";
  }
  if (classificationText.includes("confirmed issue")) {
    return "Confirmed from requirement conflict";
  }
  if (finding.issueType === "missing_requirement") {
    return "Missing from supplied context";
  }
  if (
    finding.issueType === "incomplete_criteria" ||
    finding.issueType === "non_testable_requirement" ||
    classificationText.includes("testability concern")
  ) {
    return "Inferred risk based on incomplete criteria";
  }
  if (finding.issueType === "traceability_gap") {
    return "Confirmed from related requirement/context";
  }
  return "Requires PO confirmation";
}

export function deriveSuggestedAcUpdate(finding: RequirementFinding): string {
  const suggestion = finding.suggestion.trim();
  if (deriveDeliveryImpact(finding.severity) === "Improvement / Supportability" || !suggestion) {
    return NOT_APPLICABLE_AC;
  }
  const base = `Acceptance criteria shall be updated to capture: ${ensureSentence(suggestion)}`;
  if (deriveEvidenceLevel(finding) === "Requires PO confirmation") {
    // Placeholders are wrapped in inline code so Azure DevOps' Markdown/HTML
    // sanitizer renders the angle brackets literally instead of stripping them
    // as unknown HTML tags.
    return `${base} Confirm any values still pending a business decision (such as \`<configured value>\`, \`<valid/invalid>\`, or \`<defined fallback behavior>\`) with the Product Owner before implementation.`;
  }
  return base;
}

export function deriveTestImpact(finding: RequirementFinding): string {
  if (finding.severity === "low" || finding.severity === "info") {
    return "Low test impact; track as optional or supportability coverage during regression rather than as a blocking test condition.";
  }
  if (finding.checklistItemId === "security_privacy_compliance") {
    return "Requires dedicated security and privacy validation, including authorization, data-exposure, and negative-path tests; affects compliance sign-off.";
  }
  switch (finding.issueType) {
    case "missing_requirement":
      return "Blocks complete test coverage because expected behavior for this scenario is undefined; positive, negative, and boundary cases cannot be finalized until it is clarified.";
    case "incomplete_criteria":
    case "non_testable_requirement":
      return "Blocks deterministic test-case design because acceptance criteria are not measurable; add testable criteria so expected results can be asserted.";
    case "conflict":
    case "inconsistency":
      return "Test cases cannot assert a single expected result until the conflicting sources are reconciled; affects regression and UAT validation.";
    case "ambiguity":
      return "Ambiguous wording yields non-deterministic expected results; clarify before authoring test cases to avoid false pass/fail outcomes.";
    case "unhandled_edge_case":
      return "Requires additional negative, boundary, and error-path test cases to cover the missing scenario; affects regression coverage.";
    case "unsupported_assumption":
      return "Validate the underlying assumption before test design; an incorrect assumption would invalidate the associated expected results.";
    case "ownership_gap":
      return "Confirm ownership so the expected behavior and its test oracle are agreed before test execution and sign-off.";
    case "traceability_gap":
      return "Affects traceability and regression scope; link the requirement to test cases so coverage gaps remain visible.";
    case "risk_gap":
      return "Define the risk and its mitigation so risk-based test prioritization and coverage can be planned.";
    default:
      return "Clarify before test design to keep expected results deterministic across environments.";
  }
}

function deriveActionVerb(issueType: IssueType): string {
  switch (issueType) {
    case "missing_requirement":
      return "Define missing requirement";
    case "conflict":
    case "inconsistency":
      return "Resolve conflict";
    case "ambiguity":
      return "Clarify ambiguity";
    case "incomplete_criteria":
    case "non_testable_requirement":
      return "Add testable acceptance criteria";
    case "unhandled_edge_case":
      return "Define edge-case handling";
    case "ownership_gap":
      return "Assign ownership";
    case "traceability_gap":
      return "Establish traceability";
    case "risk_gap":
      return "Assess and document risk";
    case "unsupported_assumption":
      return "Validate assumption";
    default:
      return "Clarify";
  }
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

function deriveRequiredAction(finding: RequirementFinding): string {
  // The suggested resolution is already written to be specific and actionable
  // (and the spec's own examples read like the resolution), so it makes the
  // clearest "required action". Fall back to a verb + title when absent.
  const suggestion = finding.suggestion.trim();
  if (suggestion) return firstSentence(suggestion);
  const title = finding.title.trim() || "this finding";
  return `${deriveActionVerb(finding.issueType)}: ${title}`;
}

function deriveActionImpact(finding: RequirementFinding): string {
  switch (finding.issueType) {
    case "conflict":
    case "inconsistency":
      return "Avoids conflicting implementation and non-deterministic validation";
    case "missing_requirement":
      return "Closes a requirement gap before development and test design";
    case "ambiguity":
      return "Removes ambiguity that blocks deterministic testing";
    case "incomplete_criteria":
    case "non_testable_requirement":
      return "Enables measurable acceptance criteria and deterministic testing";
    case "unhandled_edge_case":
      return "Prevents unhandled behavior and regression gaps";
    case "ownership_gap":
      return "Establishes clear ownership and accountability";
    case "traceability_gap":
      return "Improves traceability and regression coverage";
    case "risk_gap":
      return "Surfaces risk so it can be mitigated and tested";
    case "unsupported_assumption":
      return "Prevents building on an unconfirmed assumption";
    default:
      return "Improves clarity and reduces delivery risk";
  }
}

function actionPriority(severity: Severity): string {
  if (severity === "critical" || severity === "high") return "P1";
  if (severity === "medium") return "P2";
  return "P3";
}

/* ----------------------------- section builders --------------------------- */

export function buildRequirementReadinessDecision(findings: RequirementFinding[]): string {
  const counts = countBySeverity(findings);
  const blocking = counts.critical + counts.high;

  let status: string;
  let reason: string;
  let nextStep: string;

  if (blocking > 0) {
    status = "⚠️ Needs Refinement Before Implementation / Test Design";
    reason = `${blocking} High/Critical finding${blocking === 1 ? "" : "s"} may cause conflicting implementation, non-deterministic validation, or incomplete test coverage.`;
    nextStep = "Product Owner / Business Analyst should clarify the blocking findings before development or test design continues.";
  } else if (counts.medium > 0) {
    status = "⚠️ Review Recommended Before UAT";
    reason = `${counts.medium} Medium finding${counts.medium === 1 ? "" : "s"} should be reviewed to reduce ambiguity before UAT, regression, or final QA sign-off.`;
    nextStep = "Business Analyst / QA should review the Medium findings before UAT planning.";
  } else if (counts.low + counts.info > 0) {
    status = "✅ Mostly Ready With Minor Improvements";
    reason = "Only Low/Info findings remain; they are improvements that do not block implementation or test design.";
    nextStep = "Proceed with implementation and test design, and address the minor improvements opportunistically.";
  } else {
    status = "✅ Ready for Implementation / Test Design";
    reason = "No outstanding findings were selected for this requirement.";
    nextStep = "Proceed with implementation and test design.";
  }

  return [
    "## Requirement Readiness Decision",
    hardBreakLines(
      `**Status:** ${status}`,
      `**Reason:** ${reason}`,
      `**Recommended next step:** ${nextStep}`,
    ),
  ].join("\n\n");
}

export function buildExecutiveSummary(summary: RequirementSummary, findings: RequirementFinding[]): string {
  const counts = countBySeverity(findings);
  const rows: Array<[string, string]> = [
    ["Quality", formatEnumLabel(summary.overallQuality)],
    ["Clarity", formatPercentage(summary.clarityScore)],
    ["Completeness", formatPercentage(summary.completenessScore)],
    ["Testability", formatPercentage(summary.testabilityScore)],
    ["Total Findings", String(counts.total)],
  ];
  if (counts.critical > 0) rows.push(["Critical Findings", String(counts.critical)]);
  rows.push(["High Findings", String(counts.high)]);
  rows.push(["Medium Findings", String(counts.medium)]);
  rows.push(["Low Findings", String(counts.low)]);
  if (counts.info > 0) rows.push(["Info Findings", String(counts.info)]);

  const table = mdTable(["Metric", "Value"], ["---", "---:"], rows.map(([metric, value]) => [metric, value]));
  const summaryText = summary.summaryText.trim();

  return ["## Executive Summary", table, ...(summaryText ? [summaryText] : [])].join("\n\n");
}

export function buildDeliveryImpactSummary(findings: RequirementFinding[]): string {
  let blocking = 0;
  let beforeUat = 0;
  let improvement = 0;
  for (const finding of findings) {
    const impact = deriveDeliveryImpact(finding.severity);
    if (impact === "Blocking / Must Clarify") blocking += 1;
    else if (impact === "Should Clarify Before UAT") beforeUat += 1;
    else improvement += 1;
  }

  const table = mdTable(
    ["Delivery Impact", "Count", "Meaning"],
    ["---", "---:", "---"],
    [
      ["Blocking / Must Clarify", String(blocking), "Should be clarified before implementation or test design"],
      ["Should Clarify Before UAT", String(beforeUat), "Recommended to clarify before UAT, regression, or final QA sign-off"],
      ["Improvement / Supportability", String(improvement), "Useful for maintainability, support, or future test coverage"],
    ],
  );

  return ["## Delivery Impact Summary", table].join("\n\n");
}

export function buildTopRequiredActions(findings: RequirementFinding[]): string | null {
  // Required actions cover findings that must be clarified (Critical/High) or
  // should be clarified before UAT (Medium), sorted highest-severity first and
  // capped at MAX_TOP_ACTIONS. Low/Info are improvements rather than required
  // actions, so they appear only under Detailed Findings.
  const actionable = [...findings]
    .filter((finding) => finding.severity !== "low" && finding.severity !== "info")
    .sort((left, right) => severitySortRank(left.severity) - severitySortRank(right.severity));
  if (!actionable.length) return null;

  const shown = actionable.slice(0, MAX_TOP_ACTIONS);

  const table = mdTable(
    ["Priority", "Required Action", "Suggested Owner", "Impact"],
    ["---", "---", "---", "---"],
    shown.map((finding) => [
      actionPriority(finding.severity),
      escapeTableCell(deriveRequiredAction(finding)),
      escapeTableCell(deriveSuggestedOwner(finding)),
      escapeTableCell(deriveActionImpact(finding)),
    ]),
  );

  const overflow = actionable.length - shown.length;
  const note = overflow > 0
    ? `\n\n_Showing the top ${shown.length} of ${actionable.length} required actions; the remaining ${overflow} are listed under Detailed Findings._`
    : "";

  return ["## Top Required Actions", `${table}${note}`].join("\n\n");
}

export function formatDetailedFinding(finding: RequirementFinding, index: number): string {
  const severityLabel = formatEnumLabel(finding.severity);
  const title = finding.title.trim() || "Untitled finding";
  const riskJustification = finding.riskJustification.trim();
  const risk = `${formatEnumLabel(finding.riskLevel)} risk${riskJustification ? ` — ${riskJustification}` : ""}`;

  const meta = hardBreakLines(
    `**Delivery Impact:** ${deriveDeliveryImpact(finding.severity)}`,
    `**Issue Type:** ${formatEnumLabel(finding.issueType)}`,
    `**Checklist Area:** ${checklistItemTitle(finding.checklistItemId)}`,
    `**Evidence Level:** ${deriveEvidenceLevel(finding)}`,
    `**Suggested Owner:** ${deriveSuggestedOwner(finding)}`,
  );

  return [
    `### ${index + 1}. [${severityLabel}] ${title}`,
    meta,
    `**Finding:**  \n${orNotSpecified(finding.description)}`,
    `**Risk:**  \n${risk}`,
    `**Recommended Resolution:**  \n${orNotSpecified(finding.suggestion)}`,
    `**Suggested AC Update:**  \n${deriveSuggestedAcUpdate(finding)}`,
    `**Test Impact:**  \n${deriveTestImpact(finding)}`,
  ].join("\n\n");
}

function buildDetailedFindings(findings: RequirementFinding[]): string {
  const blocks = findings.map((finding, index) => formatDetailedFinding(finding, index));
  return ["## Detailed Findings", blocks.join("\n\n---\n\n")].join("\n\n");
}

/* ------------------------------- entry point ------------------------------ */

/**
 * Builds the full Requirement Analysis comment body (Markdown). The mention line
 * is prepended separately by the caller, so the body intentionally starts at the
 * work-item header. `findings` should be the selected, valid findings to include.
 */
export function buildRequirementAnalysisComment(input: {
  workItemId: string;
  summary: RequirementSummary;
  findings: RequirementFinding[];
}): string {
  const { workItemId, summary, findings } = input;

  const sections: string[] = [
    `# iTestFlow Requirement Analysis for ${workItemId}`,
    buildRequirementReadinessDecision(findings),
    buildExecutiveSummary(summary, findings),
  ];

  if (findings.length > 0) {
    sections.push(buildDeliveryImpactSummary(findings));
    const topActions = buildTopRequiredActions(findings);
    if (topActions) sections.push(topActions);
    sections.push(buildDetailedFindings(findings));
  }

  return sections.join("\n\n");
}
