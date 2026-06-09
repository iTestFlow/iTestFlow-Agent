/**
 * Pure, framework-free string formatting helpers shared across the app.
 *
 * Extracted from the client-only `test-intelligence-shared.tsx` so server-safe
 * and pure modules (e.g. the Azure DevOps requirement-analysis comment builder)
 * can format enum/percent values without importing React. The client shared
 * module re-exports these, so existing import paths keep working.
 */

export function formatEnumLabel(value: string) {
  const acronyms = new Set(["api", "llm", "ui", "ux"]);
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => {
      const normalized = part.toLowerCase();
      if (acronyms.has(normalized)) return normalized.toUpperCase();
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join(" ");
}

export function formatPercentage(value: number) {
  return `${Math.round(value)}%`;
}
