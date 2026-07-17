import {
  haveIdenticalNonEmptyEvidenceContent,
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import {
  canonicalizeProjectKnowledgeKey,
  canonicalizeProjectKnowledgeLogicalIdentity,
} from "./project-knowledge-contracts";
import {
  compareProjectKnowledgeAtomicConstraintValues,
  extractAtomicConstraint,
  normalizeProjectKnowledgeRuleFingerprint,
  projectKnowledgeAtomicConstraintIdentity,
} from "./project-knowledge-atomic-constraint";
import {
  areProjectKnowledgeDependencyTypesEquivalent,
  areProjectKnowledgeDependencyTypesHierarchyCompatible,
  canonicalizeProjectKnowledgeDependencyType,
  mostSpecificProjectKnowledgeDependencyType,
} from "./project-knowledge-dependency-type";
import type {
  ProjectKnowledgeConsolidationCategory,
  ProjectKnowledgeEntryByConsolidationCategory,
} from "./project-knowledge-consolidation";

/**
 * Candidate keys under which two entries of a category are considered the "same"
 * logical entry for merge/carry-over matching. Must stay identical to the keys
 * `consolidateProjectKnowledgeBases` groups by, so a pair the compiler would merge
 * is exactly the pair the carry-over pass would match.
 */
export function projectKnowledgeConsolidationCandidateKeys<
  TCategory extends ProjectKnowledgeConsolidationCategory,
>(
  category: TCategory,
  entry: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
): string[] {
  switch (category) {
    case "module": {
      const moduleEntry = entry as ProjectKnowledgeEntryByConsolidationCategory["module"];
      return [
        `id:${canonicalizeProjectKnowledgeLogicalIdentity(moduleEntry.id)}`,
        `name:${canonicalizeProjectKnowledgeLogicalIdentity(moduleEntry.name)}`,
      ];
    }
    case "business_rule": {
      const rule = entry as ProjectKnowledgeEntryByConsolidationCategory["business_rule"];
      return [
        `id:${canonicalizeProjectKnowledgeLogicalIdentity(rule.id)}`,
        `rule:${canonicalizeProjectKnowledgeLogicalIdentity(rule.rule)}`,
      ];
    }
    case "state_transition": {
      const transition = entry as ProjectKnowledgeEntryByConsolidationCategory["state_transition"];
      return [
        `id:${canonicalizeProjectKnowledgeLogicalIdentity(transition.id)}`,
        `transition:${canonicalizeProjectKnowledgeLogicalIdentity([
          transition.workflowName,
          transition.fromState,
          transition.toState,
          transition.triggerOrCondition,
        ].filter(Boolean).join(" "))}`,
      ];
    }
    case "glossary": {
      const term = entry as ProjectKnowledgeEntryByConsolidationCategory["glossary"];
      return [`term:${canonicalizeProjectKnowledgeLogicalIdentity(term.term)}`];
    }
    case "dependency": {
      const dependency = entry as ProjectKnowledgeEntryByConsolidationCategory["dependency"];
      return [
        `id:${canonicalizeProjectKnowledgeLogicalIdentity(dependency.id)}`,
        `dependency:${canonicalizeProjectKnowledgeLogicalIdentity([
          dependency.sourceModule,
          dependency.targetModule,
          canonicalizeProjectKnowledgeDependencyType(dependency.dependencyType),
        ].join(" "))}`,
      ];
    }
  }
}

/**
 * Whether two entries already matched to the same logical subject are structurally
 * safe to consolidate. Module and glossary text may add supported detail without
 * becoming a conflict. Structured categories retain category-specific guards:
 * business rules only merge when their atomic claim agrees, or — when both
 * extractions abstain — when the fingerprint agrees or both cite identical
 * non-empty evidence content (same-identity rewording of one source claim is
 * paraphrase noise, not a disagreement). Transitions must agree on their target
 * state, and dependency endpoints/types must match.
 *
 * Dependencies require identical non-empty evidence content even during draft
 * consolidation: a generic dependency may only be upgraded when both entries
 * describe the same evidenced relationship. Wording carry-over additionally
 * requires identical evidence content for every category.
 */
export function isCompatibleProjectKnowledgeParaphrase<
  TCategory extends ProjectKnowledgeConsolidationCategory,
>(
  category: TCategory,
  first: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
  second: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
): boolean {
  switch (category) {
    case "module":
    case "glossary":
      return true;
    case "business_rule": {
      const firstRule = first as ProjectKnowledgeEntryByConsolidationCategory["business_rule"];
      const secondRule = second as ProjectKnowledgeEntryByConsolidationCategory["business_rule"];
      const firstConstraint = firstRule.constraint ?? extractAtomicConstraint(firstRule.rule);
      const secondConstraint = secondRule.constraint ?? extractAtomicConstraint(secondRule.rule);

      if (firstConstraint && secondConstraint) {
        // Module qualification is a conflict concern, not a duplicate-merge
        // concern. Equivalent claims can span surfaces; consolidation retains
        // every source module in moduleAssociations and chooses a stable primary.
        if (
          projectKnowledgeAtomicConstraintIdentity(firstConstraint) !==
          projectKnowledgeAtomicConstraintIdentity(secondConstraint)
        ) {
          return false;
        }
        return compareProjectKnowledgeAtomicConstraintValues(firstConstraint, secondConstraint) === "equivalent";
      }

      // Extraction abstention is not proof of equivalence. Wording may only be
      // treated as paraphrase noise when the closed, language-agnostic
      // fingerprint agrees exactly, or when both entries cite identical
      // non-empty evidence content — the same source claim reworded.
      if (!firstConstraint && !secondConstraint) {
        return normalizeProjectKnowledgeRuleFingerprint(firstRule.rule) ===
            normalizeProjectKnowledgeRuleFingerprint(secondRule.rule) ||
          haveIdenticalNonEmptyEvidenceContent(firstRule.evidenceRefs, secondRule.evidenceRefs);
      }

      return false;
    }
    case "state_transition": {
      const firstTransition = first as ProjectKnowledgeEntryByConsolidationCategory["state_transition"];
      const secondTransition = second as ProjectKnowledgeEntryByConsolidationCategory["state_transition"];
      // Mirrors detectTransitionConflicts: an absent toState is "unknown", not a value —
      // two unknown targets must never count as agreement or distinct transitions with
      // the same id would silently merge into a chimera.
      const firstTarget = canonicalizeProjectKnowledgeKey(firstTransition.toState ?? "");
      const secondTarget = canonicalizeProjectKnowledgeKey(secondTransition.toState ?? "");
      return firstTarget.length > 0 && firstTarget === secondTarget;
    }
    case "dependency": {
      const firstDependency = first as ProjectKnowledgeEntryByConsolidationCategory["dependency"];
      const secondDependency = second as ProjectKnowledgeEntryByConsolidationCategory["dependency"];
      if (dependencyEndpointTupleKey(firstDependency) !== dependencyEndpointTupleKey(secondDependency)) {
        return false;
      }
      const identicalEvidence = haveIdenticalNonEmptyEvidenceContent(
        firstDependency.evidenceRefs,
        secondDependency.evidenceRefs,
      );
      if (!identicalEvidence) return false;
      return areProjectKnowledgeDependencyTypesEquivalent(
        firstDependency.dependencyType,
        secondDependency.dependencyType,
        { identicalEvidence },
      );
    }
  }
}

function dependencyEndpointTupleKey(dependency: ProjectKnowledgeEntryByConsolidationCategory["dependency"]) {
  return canonicalizeProjectKnowledgeLogicalIdentity(
    [dependency.sourceModule, dependency.targetModule].join(" "),
  );
}

export type ProjectKnowledgeWordingCarryOverResult = {
  knowledgeBase: ProjectKnowledgeBase;
  wordingCarryOverCount: number;
};

const CARRY_OVER_FIELDS: { [TCategory in ProjectKnowledgeConsolidationCategory]: ReadonlyArray<
  keyof ProjectKnowledgeEntryByConsolidationCategory[TCategory] & string
> } = {
  // Identity + every text field in the category's semantic projection. Restoring the
  // previous id (term for glossary) is required: per-entry semantic hashes and
  // operations are keyed on it, and without it a pure wording carry-over would still
  // read as a semantic change and publication auto-advancement could never fire.
  module: ["id", "name", "description"],
  business_rule: ["id", "rule", "sourceField", "moduleName"],
  state_transition: ["id", "workflowName", "fromState", "toState", "triggerOrCondition", "actor", "moduleName"],
  glossary: ["term", "type", "definition"],
  dependency: ["id", "sourceModule", "targetModule", "dependencyType", "description"],
};

const CATEGORY_TO_BASE_KEY: { [TCategory in ProjectKnowledgeConsolidationCategory]: keyof ProjectKnowledgeBase } = {
  module: "modules",
  business_rule: "businessRules",
  state_transition: "stateTransitions",
  glossary: "glossary",
  dependency: "crossDependencies",
};

// Fields other entries reference BY SURFACE NAME (dependency endpoints, moduleName
// links). The final base-schema parse reconciles dependency endpoints with
// whitespace-only normalization, which is stricter than the logical-identity keys used
// for matching — restoring a name that differs at that level (e.g. underscores vs
// spaces) would mutate or dangle entries the carry-over never matched. Such restores
// are skipped entirely.
const REFERENCE_NAME_FIELDS: { [TCategory in ProjectKnowledgeConsolidationCategory]: ReadonlyArray<
  keyof ProjectKnowledgeEntryByConsolidationCategory[TCategory] & string
> } = {
  module: ["name"],
  business_rule: ["moduleName"],
  state_transition: ["workflowName", "moduleName"],
  glossary: ["term"],
  dependency: ["sourceModule", "targetModule"],
};

/**
 * Deterministically restores the previously published wording of entries the
 * compiler re-extracted without any change in evidence content. The new entry's
 * evidenceRefs are kept (current snapshot ids stay valid), so the result diffs as
 * a provenance-only refresh instead of an LLM paraphrase of unchanged sources.
 */
export function carryOverProjectKnowledgeWording(input: {
  previousKnowledgeBase: ProjectKnowledgeBase | null;
  knowledgeBase: ProjectKnowledgeBase;
}): ProjectKnowledgeWordingCarryOverResult {
  if (!input.previousKnowledgeBase) {
    return { knowledgeBase: input.knowledgeBase, wordingCarryOverCount: 0 };
  }

  let wordingCarryOverCount = 0;
  const carried: Record<string, unknown> = { ...input.knowledgeBase };

  for (const category of Object.keys(CARRY_OVER_FIELDS) as ProjectKnowledgeConsolidationCategory[]) {
    const result = carryOverCategory(
      category,
      input.previousKnowledgeBase[CATEGORY_TO_BASE_KEY[category]] as ProjectKnowledgeEntryByConsolidationCategory[typeof category][],
      input.knowledgeBase[CATEGORY_TO_BASE_KEY[category]] as ProjectKnowledgeEntryByConsolidationCategory[typeof category][],
    );
    carried[CATEGORY_TO_BASE_KEY[category]] = result.entries;
    wordingCarryOverCount += result.carryOverCount;
  }

  if (!wordingCarryOverCount) {
    return { knowledgeBase: input.knowledgeBase, wordingCarryOverCount: 0 };
  }

  return {
    knowledgeBase: ProjectKnowledgeBaseSchema.parse(carried),
    wordingCarryOverCount,
  };
}

function carryOverCategory<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  previousEntries: ProjectKnowledgeEntryByConsolidationCategory[TCategory][],
  nextEntries: ProjectKnowledgeEntryByConsolidationCategory[TCategory][],
): { entries: ProjectKnowledgeEntryByConsolidationCategory[TCategory][]; carryOverCount: number } {
  if (!previousEntries.length || !nextEntries.length) {
    return { entries: nextEntries, carryOverCount: 0 };
  }

  const previousByKey = new Map<string, ProjectKnowledgeEntryByConsolidationCategory[TCategory][]>();
  previousEntries.forEach((entry) => {
    new Set(candidateKeys(category, entry)).forEach((key) => {
      const bucket = previousByKey.get(key) ?? [];
      bucket.push(entry);
      previousByKey.set(key, bucket);
    });
  });

  // Evolving candidate-key sets per next entry: used to detect restores that would
  // manufacture a NEW identity collision between two entries of this draft.
  const currentKeys = nextEntries.map((entry) => new Set(candidateKeys(category, entry)));
  const consumed = new Set<ProjectKnowledgeEntryByConsolidationCategory[TCategory]>();
  let carryOverCount = 0;

  const entries = nextEntries.map((next, index) => {
    const candidates = new Set<ProjectKnowledgeEntryByConsolidationCategory[TCategory]>();
    candidateKeys(category, next).forEach((key) => {
      (previousByKey.get(key) ?? []).forEach((candidate) => candidates.add(candidate));
    });
    const matches = Array.from(candidates).filter((previous) =>
      !consumed.has(previous) &&
      haveIdenticalNonEmptyEvidenceContent(previous.evidenceRefs, next.evidenceRefs) &&
      isCompatibleProjectKnowledgeParaphrase(category, previous, next) &&
      hasCompatibleReferenceNames(category, previous, next));
    // Ambiguity means we cannot know which previous wording this entry continues — skip.
    if (matches.length !== 1) return next;

    const previous = matches[0];
    const restored = { ...next } as Record<string, unknown>;
    let changed = false;
    for (const field of CARRY_OVER_FIELDS[category]) {
      const previousValue = (previous as Record<string, unknown>)[field];
      const carryOverValue = resolveCarryOverFieldValue(category, field, previous, next, previousValue);
      if (restored[field] !== carryOverValue) changed = true;
      restored[field] = carryOverValue;
    }
    consumed.add(previous);
    if (!changed) return next;

    const restoredEntry = restored as ProjectKnowledgeEntryByConsolidationCategory[TCategory];
    const restoredKeys = new Set(candidateKeys(category, restoredEntry));
    const introducesCollision = Array.from(restoredKeys).some((key) =>
      !currentKeys[index].has(key) &&
      currentKeys.some((keys, otherIndex) => otherIndex !== index && keys.has(key)));
    if (introducesCollision) return next;

    currentKeys[index] = restoredKeys;
    carryOverCount += 1;
    return restoredEntry;
  });

  return { entries, carryOverCount };
}

function resolveCarryOverFieldValue<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  field: keyof ProjectKnowledgeEntryByConsolidationCategory[TCategory] & string,
  previous: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
  next: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
  previousValue: unknown,
) {
  if (category !== "dependency" || field !== "dependencyType") return previousValue;

  const previousDependency = previous as ProjectKnowledgeEntryByConsolidationCategory["dependency"];
  const nextDependency = next as ProjectKnowledgeEntryByConsolidationCategory["dependency"];
  const previousType = previousDependency.dependencyType;
  const nextType = nextDependency.dependencyType;
  if (
    canonicalizeProjectKnowledgeDependencyType(previousType) ===
    canonicalizeProjectKnowledgeDependencyType(nextType) ||
    !areProjectKnowledgeDependencyTypesHierarchyCompatible(previousType, nextType)
  ) {
    return previousValue;
  }

  return mostSpecificProjectKnowledgeDependencyType(previousType, nextType);
}

function hasCompatibleReferenceNames<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  previous: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
  next: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
) {
  return REFERENCE_NAME_FIELDS[category].every((field) =>
    normalizeReferenceName((previous as Record<string, unknown>)[field]) ===
    normalizeReferenceName((next as Record<string, unknown>)[field]));
}

// Same normalization the base schema's dependency-endpoint reconciliation applies:
// whitespace and case only. Deliberately stricter than the logical-identity keys.
function normalizeReferenceName(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function candidateKeys<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  entry: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
) {
  return projectKnowledgeConsolidationCandidateKeys(category, entry).filter((key) => key && !key.endsWith(":"));
}
