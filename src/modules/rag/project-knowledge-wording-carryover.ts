import {
  haveIdenticalNonEmptyEvidenceContent,
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import {
  canonicalizeProjectKnowledgeKey,
  canonicalizeProjectKnowledgeLogicalIdentity,
} from "./project-knowledge-contracts";
import { parseConcreteRule } from "./project-knowledge-conflicts";
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
          dependency.dependencyType,
        ].join(" "))}`,
      ];
    }
  }
}

/**
 * Whether two same-identity entries whose evidence content is identical differ only
 * in safe-to-merge wording. Callers must have already established evidence-content
 * identity (haveIdenticalNonEmptyEvidenceContent) — this gate adds the category
 * guards that keep genuine disagreements out of automatic merges:
 * business rules with differing concrete values stay unmerged so
 * incompatible_concrete_value conflicts remain intact, and transitions must agree
 * on the target state.
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
      // Value-only comparison: the candidate-key precondition (same id or same
      // normalized rule text) plus full evidence identity bound the risk of two
      // different subjects sharing a value.
      const firstRule = first as ProjectKnowledgeEntryByConsolidationCategory["business_rule"];
      const secondRule = second as ProjectKnowledgeEntryByConsolidationCategory["business_rule"];
      const firstConcrete = parseConcreteRule(firstRule.rule);
      const secondConcrete = parseConcreteRule(secondRule.rule);
      if (!firstConcrete && !secondConcrete) return true;
      return Boolean(firstConcrete && secondConcrete && firstConcrete.value === secondConcrete.value);
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
      return dependencyTupleKey(firstDependency) === dependencyTupleKey(secondDependency);
    }
  }
}

function dependencyTupleKey(dependency: ProjectKnowledgeEntryByConsolidationCategory["dependency"]) {
  return canonicalizeProjectKnowledgeLogicalIdentity(
    [dependency.sourceModule, dependency.targetModule, dependency.dependencyType].join(" "),
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
      if (restored[field] !== previousValue) changed = true;
      restored[field] = previousValue;
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
