import type { ProjectKnowledgeBase } from "./project-knowledge.schema";
import type { ProjectKnowledgeLintIssue } from "./project-knowledge-compiled.service";

type NameSimilarityIssue = Omit<ProjectKnowledgeLintIssue, "id" | "createdAt" | "updatedAt" | "status" | "origin">;

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Canonical form for name-similarity comparison: lowercase, punctuation stripped,
 * and generic head/qualifier words removed so "Payment Service" and "Payment"
 * compare as the same token set.
 */
export function similarityKey(value: string) {
  return normalizeKey(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|module|system|service)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Two canonical names are similar only when they share at least two words that
 * cover ≥66% of the larger name's word set. A raw substring test was removed
 * deliberately: after stopword stripping it collapsed whole families to one head
 * noun ("payment") and flagged every entry containing it, flooding the lint panel.
 */
export function areNamesSimilar(first: string, second: string) {
  if (first.length < 5 || second.length < 5) return false;
  const firstWords = new Set(first.split(" "));
  const secondWords = new Set(second.split(" "));
  const overlap = Array.from(firstWords).filter((word) => secondWords.has(word)).length;
  return overlap >= 2 && overlap / Math.max(firstWords.size, secondWords.size) >= 0.66;
}

export function addNameSimilarityIssues(
  knowledgeBase: ProjectKnowledgeBase,
  issues: NameSimilarityIssue[],
) {
  const names = [
    ...knowledgeBase.modules.map((entry) => ({
      category: "module",
      entryKey: entry.id,
      name: entry.name,
      sourceWorkItemIds: entry.sourceWorkItemIds,
    })),
    ...knowledgeBase.glossary.map((entry) => ({
      category: "glossary",
      entryKey: entry.term,
      name: entry.term,
      sourceWorkItemIds: entry.sourceWorkItemIds,
    })),
  ];
  for (let firstIndex = 0; firstIndex < names.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < names.length; secondIndex += 1) {
      const first = names[firstIndex];
      const second = names[secondIndex];
      const firstKey = similarityKey(first.name);
      const secondKey = similarityKey(second.name);
      if (firstKey === secondKey || !areNamesSimilar(firstKey, secondKey)) continue;
      issues.push({
        issueType: "similar_name",
        severity: "warning",
        title: `Potential duplicate names: ${first.name} / ${second.name}`,
        message: "Canonical name similarity indicates that these entries may represent the same subject. Review before merging.",
        category: first.category === second.category ? first.category : "cross_category",
        entryKey: [first.entryKey, second.entryKey].sort().join(" | "),
        sourceWorkItemIds: Array.from(new Set([...first.sourceWorkItemIds, ...second.sourceWorkItemIds])),
      });
    }
  }
}
