import type { ProjectKnowledgeBase } from "./project-knowledge.schema";
import {
  computeProjectKnowledgeHashes,
  getEntryProvenanceStatus,
} from "./project-knowledge-contracts";
import { detectProjectKnowledgeHardConflicts } from "./project-knowledge-conflicts";
import { hasProjectKnowledgeDuplicateLogicalIdentities } from "./project-knowledge-duplicate-resolution";
import { buildProjectKnowledgeOperations } from "./project-knowledge-reconciliation";

export type AutomaticProvenanceRefreshDecision =
  | { allowed: true; touchedEntryKeys: string[] }
  | { allowed: false; reason: string };

export function evaluateAutomaticProvenanceRefresh(input: {
  publishedKnowledgeBase: ProjectKnowledgeBase;
  publishedSemanticHash: string | null;
  parentKnowledgeBase: ProjectKnowledgeBase;
  parentSemanticHash: string | null;
  childKnowledgeBase: ProjectKnowledgeBase;
  childSemanticHash: string | null;
  currentActiveRevisionId: string | null;
  childBaseRevisionId: string | null;
  childBlockers: unknown[];
}): AutomaticProvenanceRefreshDecision {
  if (!input.currentActiveRevisionId || input.childBaseRevisionId !== input.currentActiveRevisionId) {
    return { allowed: false, reason: "active_revision_changed" };
  }
  if (input.childBlockers.length) return { allowed: false, reason: "publication_blockers" };

  const published = computeProjectKnowledgeHashes(input.publishedKnowledgeBase);
  const parent = computeProjectKnowledgeHashes(input.parentKnowledgeBase);
  const child = computeProjectKnowledgeHashes(input.childKnowledgeBase);
  if (
    input.publishedSemanticHash !== published.semanticKnowledgeHash ||
    input.parentSemanticHash !== parent.semanticKnowledgeHash ||
    input.childSemanticHash !== child.semanticKnowledgeHash
  ) {
    return { allowed: false, reason: "persisted_hash_mismatch" };
  }
  if (
    published.semanticKnowledgeHash !== parent.semanticKnowledgeHash ||
    published.semanticKnowledgeHash !== child.semanticKnowledgeHash
  ) {
    return { allowed: false, reason: "semantic_change" };
  }
  if (detectProjectKnowledgeHardConflicts(input.childKnowledgeBase).length) {
    return { allowed: false, reason: "hard_conflict" };
  }
  if (hasProjectKnowledgeDuplicateLogicalIdentities(input.childKnowledgeBase)) {
    return { allowed: false, reason: "duplicate_logical_identity" };
  }

  const operations = buildProjectKnowledgeOperations({
    baseKnowledgeBase: input.publishedKnowledgeBase,
    proposedKnowledgeBase: input.childKnowledgeBase,
  });
  if (operations.some((operation) => operation.type !== "confirm")) {
    return { allowed: false, reason: "non_provenance_operation" };
  }

  const publishedEntries = new Map(published.entries.map((entry) => [
    `${entry.category}:${entry.entryKey}`,
    entry,
  ]));
  const touchedEntries = child.entries.filter((entry) => {
    const previous = publishedEntries.get(`${entry.category}:${entry.entryKey}`);
    return previous?.entryProvenanceHash !== entry.entryProvenanceHash;
  });
  if (touchedEntries.some((entry) => getEntryProvenanceStatus(entry.evidenceRefs) !== "verified")) {
    return { allowed: false, reason: "unverified_touched_entry" };
  }

  return {
    allowed: true,
    touchedEntryKeys: touchedEntries.map((entry) => `${entry.category}:${entry.entryKey}`).sort(),
  };
}
