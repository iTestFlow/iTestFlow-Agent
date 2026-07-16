import {
  ProjectKnowledgeBusinessRuleSchema,
  ProjectKnowledgeCrossDependencySchema,
  ProjectKnowledgeGlossaryTermSchema,
  ProjectKnowledgeModuleSchema,
  ProjectKnowledgeStateTransitionSchema,
  mergeProjectKnowledgeEvidenceRefs,
  splitProjectKnowledgeLegacyEvidence,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import { mostSpecificProjectKnowledgeDependencyType } from "./project-knowledge-dependency-type";

export type ProjectKnowledgeConsolidationCategory =
  | "module"
  | "business_rule"
  | "state_transition"
  | "glossary"
  | "dependency";

export type ProjectKnowledgeEntryByConsolidationCategory = {
  module: ProjectKnowledgeBase["modules"][number];
  business_rule: ProjectKnowledgeBase["businessRules"][number];
  state_transition: ProjectKnowledgeBase["stateTransitions"][number];
  glossary: ProjectKnowledgeBase["glossary"][number];
  dependency: ProjectKnowledgeBase["crossDependencies"][number];
};

export type ProjectKnowledgeConsolidationEntry =
  ProjectKnowledgeEntryByConsolidationCategory[ProjectKnowledgeConsolidationCategory];

const GLOSSARY_TYPE_PRIORITY: Record<ProjectKnowledgeBase["glossary"][number]["type"], number> = {
  business_entity: 1,
  process: 2,
  role: 3,
  actor: 4,
  external_service: 5,
  system: 6,
  data_entity: 7,
  term: 8,
};

/**
 * Applies the compiler's deterministic, category-aware merge policy to entries
 * that have already been deemed safe to consolidate. This module intentionally
 * has no server-only dependencies so the review UI can use the exact same merge.
 */
export function mergeProjectKnowledgeConflictEntries<
  TCategory extends ProjectKnowledgeConsolidationCategory,
>(
  category: TCategory,
  entries: readonly ProjectKnowledgeEntryByConsolidationCategory[TCategory][],
): ProjectKnowledgeEntryByConsolidationCategory[TCategory] {
  if (!entries.length) {
    throw new Error("At least one knowledge entry is required for consolidation.");
  }

  switch (category) {
    case "module":
      return mergeModules(entries as readonly ProjectKnowledgeEntryByConsolidationCategory["module"][]) as
        ProjectKnowledgeEntryByConsolidationCategory[TCategory];
    case "business_rule":
      return mergeBusinessRules(entries as readonly ProjectKnowledgeEntryByConsolidationCategory["business_rule"][]) as
        ProjectKnowledgeEntryByConsolidationCategory[TCategory];
    case "state_transition":
      return mergeStateTransitions(entries as readonly ProjectKnowledgeEntryByConsolidationCategory["state_transition"][]) as
        ProjectKnowledgeEntryByConsolidationCategory[TCategory];
    case "glossary":
      return mergeGlossaryTerms(entries as readonly ProjectKnowledgeEntryByConsolidationCategory["glossary"][]) as
        ProjectKnowledgeEntryByConsolidationCategory[TCategory];
    case "dependency":
      return mergeDependencies(entries as readonly ProjectKnowledgeEntryByConsolidationCategory["dependency"][]) as
        ProjectKnowledgeEntryByConsolidationCategory[TCategory];
  }
}

function mergeModules(entries: readonly ProjectKnowledgeEntryByConsolidationCategory["module"][]) {
  return ProjectKnowledgeModuleSchema.parse(entries.slice(1).reduce((first, second) => ({
    ...first,
    name: chooseLongerText(first.name, second.name),
    description: chooseLongerText(first.description, second.description),
    ...mergeProvenance(first, second),
  }), entries[0]));
}

function mergeBusinessRules(entries: readonly ProjectKnowledgeEntryByConsolidationCategory["business_rule"][]) {
  const merged = entries.slice(1).reduce((first, second) => ({
    ...first,
    rule: chooseLongerText(first.rule, second.rule),
    sourceField: first.sourceField || second.sourceField,
    ...mergeProvenance(first, second),
  }), entries[0]);

  const constraint = chooseBusinessRuleConstraint(entries);
  return ProjectKnowledgeBusinessRuleSchema.parse({
    ...merged,
    ...mergeBusinessRuleModuleAssociations(entries),
    ...(constraint ? { constraint } : {}),
  });
}

function mergeStateTransitions(entries: readonly ProjectKnowledgeEntryByConsolidationCategory["state_transition"][]) {
  return ProjectKnowledgeStateTransitionSchema.parse(entries.slice(1).reduce((first, second) => ({
    ...first,
    workflowName: first.workflowName || second.workflowName,
    fromState: first.fromState ?? second.fromState,
    toState: first.toState ?? second.toState,
    triggerOrCondition: chooseLongerText(first.triggerOrCondition, second.triggerOrCondition),
    actor: first.actor ?? second.actor,
    moduleName: first.moduleName ?? second.moduleName,
    ...mergeProvenance(first, second),
  }), entries[0]));
}

function mergeGlossaryTerms(entries: readonly ProjectKnowledgeEntryByConsolidationCategory["glossary"][]) {
  return ProjectKnowledgeGlossaryTermSchema.parse(entries.slice(1).reduce((first, second) => ({
    ...preferGlossaryType(first, second),
    definition: chooseLongerText(first.definition, second.definition),
    ...mergeProvenance(first, second),
  }), entries[0]));
}

function mergeDependencies(entries: readonly ProjectKnowledgeEntryByConsolidationCategory["dependency"][]) {
  return ProjectKnowledgeCrossDependencySchema.parse(entries.slice(1).reduce((first, second) => ({
    ...first,
    sourceModule: first.sourceModule || second.sourceModule,
    targetModule: first.targetModule || second.targetModule,
    dependencyType: mostSpecificProjectKnowledgeDependencyType(first.dependencyType, second.dependencyType),
    description: chooseLongerText(first.description, second.description),
    ...mergeProvenance(first, second),
  }), entries[0]));
}

function mergeBusinessRuleModuleAssociations(
  entries: readonly ProjectKnowledgeEntryByConsolidationCategory["business_rule"][],
) {
  const moduleAssociations = Array.from(new Set(entries.flatMap((entry) => [
    entry.moduleName,
    ...(entry.moduleAssociations ?? []),
  ]).map(canonicalizeProjectKnowledgeModuleAssociation).filter(Boolean))).sort(compareCanonicalText);

  return {
    ...(moduleAssociations[0] ? { moduleName: moduleAssociations[0] } : {}),
    ...(moduleAssociations.length ? { moduleAssociations } : {}),
  };
}

function chooseBusinessRuleConstraint(
  entries: readonly ProjectKnowledgeEntryByConsolidationCategory["business_rule"][],
) {
  return [...entries]
    .sort(compareBusinessRuleConstraintCandidates)
    .find((entry) => entry.constraint)?.constraint;
}

function compareBusinessRuleConstraintCandidates(
  first: ProjectKnowledgeEntryByConsolidationCategory["business_rule"],
  second: ProjectKnowledgeEntryByConsolidationCategory["business_rule"],
) {
  const firstLength = first.rule.trim().length;
  const secondLength = second.rule.trim().length;
  if (firstLength !== secondLength) return secondLength - firstLength;

  const ruleComparison = compareCanonicalText(first.rule, second.rule);
  if (ruleComparison) return ruleComparison;
  return compareCanonicalText(
    JSON.stringify(first.constraint ?? null),
    JSON.stringify(second.constraint ?? null),
  );
}

function mergeProvenance(
  first: Pick<ProjectKnowledgeBase["modules"][number], "sourceWorkItemIds" | "evidence" | "evidenceRefs">,
  second: Pick<ProjectKnowledgeBase["modules"][number], "sourceWorkItemIds" | "evidence" | "evidenceRefs">,
) {
  const evidenceRefs = mergeProjectKnowledgeEvidenceRefs(first.evidenceRefs ?? [], second.evidenceRefs ?? []);
  return {
    sourceWorkItemIds: mergeUnique(first.sourceWorkItemIds, second.sourceWorkItemIds),
    evidence: mergeEvidence(first.evidence, second.evidence),
    evidenceRefs: evidenceRefs.length ? evidenceRefs : undefined,
  };
}

function chooseLongerText(first: string, second: string) {
  const firstLength = first.trim().length;
  const secondLength = second.trim().length;
  if (firstLength !== secondLength) return firstLength > secondLength ? first : second;
  return compareCanonicalText(first, second) <= 0 ? first : second;
}

// Mirrors the project's logical-identity canonicalization without importing the
// server-only contracts module (which imports node:crypto). These associations
// are metadata, so canonical names make their union and primary selection stable.
function canonicalizeProjectKnowledgeModuleAssociation(value: string | undefined) {
  return value
    ?.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") ?? "";
}

function compareCanonicalText(first: string, second: string) {
  return first < second ? -1 : first > second ? 1 : 0;
}

function preferGlossaryType(
  first: ProjectKnowledgeEntryByConsolidationCategory["glossary"],
  second: ProjectKnowledgeEntryByConsolidationCategory["glossary"],
) {
  return GLOSSARY_TYPE_PRIORITY[second.type] < GLOSSARY_TYPE_PRIORITY[first.type] ? second : first;
}

function mergeEvidence(first: string, second: string) {
  return mergeUnique(
    splitProjectKnowledgeLegacyEvidence(first),
    splitProjectKnowledgeLegacyEvidence(second),
  ).join(" | ");
}

function mergeUnique(first: string[], second: string[]) {
  return Array.from(new Set([...first, ...second].map((value) => value.trim()).filter(Boolean)));
}
