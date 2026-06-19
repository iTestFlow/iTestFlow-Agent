import type { Tone } from "@/components/qa/tone";
import type { ExistingTraceabilityRow } from "@/components/workflow/test-intelligence-types";

/* --------------------------------------------------------------------------
 * Pure helpers for the Traceability Matrix: status counting, tone mapping,
 * source-context derivation, link extraction/cleaning, and row search text.
 * Extracted verbatim from the former test-gap-analysis-client.tsx monolith so
 * they can be unit-tested and shared by the matrix components. No React here.
 * ------------------------------------------------------------------------ */

export type TraceabilitySourceContextValue = {
  category: string;
  reference: string;
};

export type TraceabilitySourceLink = {
  href: string;
  label: string;
};

export function countTraceabilityStatuses(rows: ExistingTraceabilityRow[]) {
  return rows.reduce(
    (counts, row) => {
      counts[row.coverageStatus] += 1;
      return counts;
    },
    { Covered: 0, "Partially covered": 0, "Not covered": 0, "Needs review": 0 },
  );
}

export function scoreMetricTone(value: number): "green" | "yellow" | "red" {
  if (value >= 80) return "green";
  if (value >= 60) return "yellow";
  return "red";
}

export function coverageTone(status: ExistingTraceabilityRow["coverageStatus"]): Tone {
  if (status === "Covered") return "success";
  if (status === "Partially covered") return "warning";
  if (status === "Not covered") return "error";
  return "draft";
}

export function coverageSourceLabel(sourceType: ExistingTraceabilityRow["sourceType"]) {
  if (sourceType === "businessRules") return "Business rule";
  if (sourceType === "acceptanceCriteria") return "AC";
  if (sourceType === "description") return "Description";
  return "Story summary";
}

export function traceabilitySourceSummary(row: ExistingTraceabilityRow) {
  const reference = row.sourceReference.trim();
  if (row.sourceType === "acceptanceCriteria") {
    return extractAcceptanceCriteriaReference(reference) ?? "AC";
  }
  if (row.sourceType === "businessRules") return "Business rule";
  if (row.sourceType === "description") return "Description";
  return "Story summary";
}

export function traceabilitySourceContext(row: ExistingTraceabilityRow): TraceabilitySourceContextValue | null {
  const reference = traceabilitySourceReference(row);

  return reference
    ? {
        category: traceabilitySourceContextCategory(row),
        reference,
      }
    : null;
}

function traceabilitySourceContextCategory(row: ExistingTraceabilityRow) {
  if (row.sourceType === "acceptanceCriteria") {
    return extractAcceptanceCriteriaReference(row.sourceReference) ?? "AC";
  }
  return traceabilitySourceCategory(row.sourceType);
}

function traceabilitySourceCategory(sourceType: ExistingTraceabilityRow["sourceType"]) {
  if (sourceType === "businessRules") return "Business rule";
  if (sourceType === "acceptanceCriteria") return "AC";
  if (sourceType === "description") return "Description";
  return "Story summary";
}

function traceabilitySourceReference(row: ExistingTraceabilityRow) {
  const reference = row.sourceReference.trim();
  if (!reference) return null;

  const acceptanceCriteriaReference = extractAcceptanceCriteriaReference(reference);
  if (row.sourceType === "acceptanceCriteria" && acceptanceCriteriaReference) {
    const normalizedReference = normalizeTraceabilityLabel(reference);
    const normalizedAcReference = normalizeTraceabilityLabel(acceptanceCriteriaReference);
    return normalizedReference === normalizedAcReference ? null : reference;
  }

  const normalizedReference = normalizeTraceabilityLabel(reference);
  const genericLabels = [
    traceabilitySourceCategory(row.sourceType),
    coverageSourceLabel(row.sourceType),
    row.sourceType,
    "Story Title",
    "Title",
  ].map(normalizeTraceabilityLabel);

  return genericLabels.includes(normalizedReference) ? null : reference;
}

export function traceabilityRequirementTitle(row: ExistingTraceabilityRow) {
  const requirementText = row.requirementText.trim();
  const cleanedText = cleanTraceabilityLinkText(requirementText);

  if (isTraceabilityLinkHeavy(requirementText, cleanedText)) {
    return externalReferenceTitle(row, requirementText, cleanedText);
  }

  return cleanedText || requirementText;
}

export function traceabilitySourceText(row: ExistingTraceabilityRow) {
  const sourceText = row.sourceText?.trim();
  if (!sourceText) return null;

  const cleanedSourceText = cleanTraceabilityLinkText(sourceText);
  const displaySourceText = isTraceabilityLinkHeavy(sourceText, cleanedSourceText)
    ? cleanLinkHeavySourceText(row, cleanedSourceText)
    : cleanedSourceText;
  if (!displaySourceText) return null;

  const normalizedSourceText = normalizeTraceabilityContent(sourceText);
  const normalizedDisplaySourceText = normalizeTraceabilityContent(displaySourceText);
  const duplicateValues = [
    row.requirementText,
    row.sourceReference,
    traceabilityRequirementTitle(row),
  ].map(normalizeTraceabilityContent);

  return duplicateValues.includes(normalizedSourceText) || duplicateValues.includes(normalizedDisplaySourceText)
    ? null
    : truncateTraceabilityText(displaySourceText, 360);
}

export function traceabilitySourceLinks(row: ExistingTraceabilityRow) {
  return extractTraceabilityLinks(row.sourceText, row.requirementText, row.sourceReference);
}

export function cleanTraceabilityLinkText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1")
    .replace(/([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/gi, "$1")
    .replace(traceabilityUrlPattern, "")
    .replace(/\s*[\[\]()]+\s*/g, " ")
    .replace(/\s*[:;,.-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTraceabilityLinkHeavy(rawText: string, cleanedText: string) {
  const urls = rawText.match(traceabilityUrlPattern) ?? [];
  if (!urls.length) return false;

  const urlLength = urls.reduce((sum, url) => sum + url.length, 0);
  return cleanedText.length < 24 || urlLength > cleanedText.length * 2 || rawText.length > 180;
}

function externalReferenceTitle(row: ExistingTraceabilityRow, rawText: string, cleanedText: string) {
  const links = extractTraceabilityLinks(rawText, row.sourceText, row.sourceReference);
  const figmaLink = links.find((link) => isFigmaUrl(link.href));
  const usefulLabel = links.map((link) => link.label).find(isUsefulSourceLinkLabel);

  if (figmaLink) {
    return usefulLabel ? `${usefulLabel} design reference requires review` : "External design reference requires review";
  }

  if (usefulLabel) return `${usefulLabel} reference requires review`;
  if (cleanedText) return `${truncateTraceabilityText(cleanedText, 80)} reference requires review`;
  return "External reference requires review";
}

function cleanLinkHeavySourceText(row: ExistingTraceabilityRow, cleanedText: string) {
  const fallbackText = cleanedText || row.sourceReference.trim();
  return fallbackText && !isUrlLikeText(fallbackText) ? fallbackText : "";
}

function extractTraceabilityLinks(...values: Array<string | undefined>) {
  const links: TraceabilitySourceLink[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!value) continue;

    const markdownPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
    for (const match of value.matchAll(markdownPattern)) {
      addTraceabilityLink(links, seen, match[2], match[1]);
    }

    const looseMarkdownPattern = /([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/gi;
    for (const match of value.matchAll(looseMarkdownPattern)) {
      addTraceabilityLink(links, seen, match[2], match[1]);
    }

    for (const match of value.matchAll(traceabilityUrlPattern)) {
      addTraceabilityLink(links, seen, match[0]);
    }
  }

  return links;
}

function addTraceabilityLink(links: TraceabilitySourceLink[], seen: Set<string>, rawHref: string, rawLabel?: string) {
  const href = normalizeTraceabilityUrl(rawHref);
  if (!href || seen.has(href)) return;

  seen.add(href);
  links.push({
    href,
    label: sourceLinkLabel(href, rawLabel),
  });
}

function normalizeTraceabilityUrl(value: string) {
  return value.trim().replace(/[),.;\]]+$/g, "");
}

function sourceLinkLabel(href: string, rawLabel?: string) {
  const label = cleanTraceabilityLinkText(rawLabel ?? "");
  if (isUsefulSourceLinkLabel(label)) return truncateTraceabilityText(label, 48);
  if (isFigmaUrl(href)) return "Open Figma design";

  const host = traceabilityLinkHost(href);
  return host ? `Open ${host}` : "Open source link";
}

function isUsefulSourceLinkLabel(label: string | undefined) {
  if (!label) return false;
  const normalized = label.trim().toLowerCase();
  return normalized.length > 1 && !normalized.startsWith("http") && normalized !== "link" && normalized !== "figma link";
}

function traceabilityLinkHost(href: string) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isFigmaUrl(href: string) {
  return traceabilityLinkHost(href).endsWith("figma.com");
}

function isUrlLikeText(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

export function truncateTraceabilityText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value;
}

export function extractAcceptanceCriteriaReference(value: string) {
  const match = value.match(/\bAC[-\s]?\d+\b/i);
  return match ? match[0].replace(/\s+/, "-").toUpperCase() : null;
}

const traceabilityUrlPattern = /https?:\/\/[^\s)\]]+/gi;

function normalizeTraceabilityLabel(value: string) {
  return value.trim().replace(/[\s_-]+/g, "").toLowerCase();
}

function normalizeTraceabilityContent(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function formatLinkedTestCaseCount(count: number) {
  return `${count} linked test case${count === 1 ? "" : "s"}`;
}

export function rowSearchText(row: ExistingTraceabilityRow) {
  return [
    row.id,
    row.sourceType,
    coverageSourceLabel(row.sourceType),
    row.sourceReference,
    row.sourceText,
    row.requirementText,
    row.coverageStatus,
    row.severity,
    row.linkedTestCaseIds.join(" "),
    row.evidenceSummary,
    row.missingCoverage,
    row.recommendedAction,
  ].filter(Boolean).join(" ").toLowerCase();
}
