import {
  PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS,
  PROJECT_KNOWLEDGE_SOURCE_FIELDS,
  ProjectKnowledgeBaseSchema,
  splitProjectKnowledgeLegacyEvidence,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";
import type { ProjectKnowledgeEvidenceSnapshot } from "./project-knowledge-provenance";

type RepairableEntry = {
  category: "module" | "business_rule" | "state_transition" | "glossary" | "dependency";
  entryKey: string;
  value: {
    evidence: string;
    sourceWorkItemIds: string[];
    evidenceRefs?: ProjectKnowledgeEvidenceRef[];
  };
};

export type ProjectKnowledgeEvidenceRepairResult = {
  knowledgeBase: ProjectKnowledgeBase;
  attemptedEntryCount: number;
  repairedEntryCount: number;
  unresolvedEntryCount: number;
};

export function repairMissingProjectKnowledgeEvidenceRefs(input: {
  knowledgeBase: ProjectKnowledgeBase;
  snapshots: ProjectKnowledgeEvidenceSnapshot[];
  touchedKeys?: Set<string>;
}): ProjectKnowledgeEvidenceRepairResult {
  const knowledgeBase = structuredClone(ProjectKnowledgeBaseSchema.parse(input.knowledgeBase));
  let attemptedEntryCount = 0;
  let repairedEntryCount = 0;
  let unresolvedEntryCount = 0;

  for (const entry of repairableEntries(knowledgeBase)) {
    const identity = `${entry.category}:${entry.entryKey}`;
    if (input.touchedKeys && !input.touchedKeys.has(identity)) continue;
    if (entry.value.evidenceRefs?.length) continue;
    attemptedEntryCount += 1;
    const fragments = splitProjectKnowledgeLegacyEvidence(entry.value.evidence);
    const allowedSourceIds = new Set(entry.value.sourceWorkItemIds);
    const snapshots = input.snapshots.filter((snapshot) => allowedSourceIds.has(snapshot.sourceWorkItemId));
    const allowedFields = entry.category === "business_rule"
      ? PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS
      : PROJECT_KNOWLEDGE_SOURCE_FIELDS;
    const matches = fragments.map((fragment) => uniqueFragmentMatch(snapshots, allowedFields, fragment));

    if (!fragments.length || matches.some((match) => !match)) {
      unresolvedEntryCount += 1;
      continue;
    }

    entry.value.evidenceRefs = matches as ProjectKnowledgeEvidenceRef[];
    repairedEntryCount += 1;
  }

  return {
    knowledgeBase: ProjectKnowledgeBaseSchema.parse(knowledgeBase),
    attemptedEntryCount,
    repairedEntryCount,
    unresolvedEntryCount,
  };
}

function uniqueFragmentMatch(
  snapshots: ProjectKnowledgeEvidenceSnapshot[],
  allowedFields: readonly ProjectKnowledgeEvidenceRef["sourceField"][],
  fragment: string,
) {
  const matches = snapshots.flatMap((snapshot) => allowedFields.flatMap((sourceField) => {
    const fieldText = snapshotFieldText(snapshot.fields, sourceField);
    if (!fieldText) return [];
    const verification = fieldText.includes(fragment)
      ? "exact" as const
      : normalizeWhitespace(fieldText).includes(normalizeWhitespace(fragment))
        ? "normalized" as const
        : null;
    if (!verification) return [];
    return [{
      sourceSnapshotId: snapshot.id,
      sourceWorkItemId: snapshot.sourceWorkItemId,
      sourceField,
      quote: fragment,
      origin: "generated_v2" as const,
      verification,
    }];
  }));
  return matches.length === 1 ? matches[0] : null;
}

function repairableEntries(knowledgeBase: ProjectKnowledgeBase): RepairableEntry[] {
  return [
    ...knowledgeBase.modules.map((value) => ({ category: "module" as const, entryKey: canonicalKey(value.id), value })),
    ...knowledgeBase.businessRules.map((value) => ({ category: "business_rule" as const, entryKey: canonicalKey(value.id), value })),
    ...knowledgeBase.stateTransitions.map((value) => ({ category: "state_transition" as const, entryKey: canonicalKey(value.id), value })),
    ...knowledgeBase.glossary.map((value) => ({ category: "glossary" as const, entryKey: canonicalKey(value.term), value })),
    ...knowledgeBase.crossDependencies.map((value) => ({ category: "dependency" as const, entryKey: canonicalKey(value.id), value })),
  ];
}

function canonicalKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function snapshotFieldText(fields: Record<string, unknown>, sourceField: string) {
  const value = fields[sourceField];
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return sourceField === "metadata" ? JSON.stringify(value) : String(value);
}

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}
