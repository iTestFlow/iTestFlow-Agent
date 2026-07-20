import type { ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

export const PROJECT_KNOWLEDGE_SOURCE_PROJECTION_VERSION = "plain-text-v1";

export function projectKnowledgeSourceFieldText(
  fields: Record<string, unknown>,
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"],
) {
  return projectKnowledgeCanonicalSourceText(fields[sourceField], sourceField);
}

export function projectKnowledgeCanonicalSourceText(
  value: unknown,
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"],
) {
  if (value === undefined || value === null) return "";
  const rendered = sourceField === "tags"
    ? (Array.isArray(value) ? value : String(value).split(";")).map((entry) => String(entry).trim()).filter(Boolean).join("; ")
    : Array.isArray(value)
    ? value.map((entry) => String(entry)).join("; ")
    : typeof value === "string"
      ? value
      : sourceField === "metadata"
        ? stableStringify(value)
        : String(value);
  return normalizeProjectKnowledgeSourceWhitespace(stripProjectKnowledgeSourceHtml(rendered));
}

export function normalizeProjectKnowledgeSourceWhitespace(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function stripProjectKnowledgeSourceHtml(value: string) {
  return decodeBasicHtmlEntities(
    value
      .replace(/<\s*br\s*\/?\s*>/gi, " ")
      .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodeBasicHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, code: string) => decodeCodePoint(match, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => decodeCodePoint(match, Number.parseInt(code, 16)));
}

function decodeCodePoint(fallback: string, codePoint: number) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}
