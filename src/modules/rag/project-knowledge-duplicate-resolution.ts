import {
  compareProjectKnowledgeAtomicConstraintValues,
  extractAtomicConstraint,
  normalizeProjectKnowledgeRuleFingerprint,
  projectKnowledgeAtomicConstraintIdentity,
  ProjectKnowledgeAtomicConstraintSchema,
  type ProjectKnowledgeAtomicConstraint,
} from "./project-knowledge-atomic-constraint";
import {
  canonicalizeBusinessRuleSourceFieldForProjection,
  canonicalizeProjectKnowledgeLogicalIdentity,
  compareProjectKnowledgeCanonicalText,
  hashCanonicalValue,
  type ProjectKnowledgeEntryCategory,
} from "./project-knowledge-contracts";
import {
  mergeProjectKnowledgeConflictEntries,
  type ProjectKnowledgeConsolidationCategory,
} from "./project-knowledge-consolidation";
import {
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import { isCompatibleProjectKnowledgeParaphrase } from "./project-knowledge-wording-carryover";

export type ProjectKnowledgePossibleTension = {
  category: ProjectKnowledgeEntryCategory;
  subject: string;
  entryKeys: string[];
  reason: string;
};

export type ProjectKnowledgeDuplicateResolutionCounters = {
  preConsolidationDuplicateIdentityCount: number;
  paraphraseMergeCount: number;
  rekeyCount: number;
  atomicExtractionFailureCount: number;
  possibleTensionCount: number;
};

export type ProjectKnowledgeDuplicateResolutionResult = {
  knowledgeBase: ProjectKnowledgeBase;
  counters: ProjectKnowledgeDuplicateResolutionCounters;
  possibleTensions: ProjectKnowledgePossibleTension[];
};

/**
 * Resolves repeated logical IDs without ever turning a collision into a review
 * blocker by itself. Exact category-specific merges are retained; every other
 * survivor receives a deterministic new key before conflict detection runs.
 */
export function resolveProjectKnowledgeDuplicateIdentities(
  knowledgeBaseInput: ProjectKnowledgeBase,
): ProjectKnowledgeDuplicateResolutionResult {
  const knowledgeBase = ProjectKnowledgeBaseSchema.parse(knowledgeBaseInput);
  const counters: ProjectKnowledgeDuplicateResolutionCounters = {
    preConsolidationDuplicateIdentityCount: countDuplicateLogicalIdentities(knowledgeBase),
    paraphraseMergeCount: 0,
    rekeyCount: 0,
    atomicExtractionFailureCount: 0,
    possibleTensionCount: 0,
  };
  const possibleTensions: ProjectKnowledgePossibleTension[] = [];

  const modules = resolveAlwaysMergeCategory("module", knowledgeBase.modules, counters);
  const glossary = resolveAlwaysMergeCategory("glossary", knowledgeBase.glossary, counters);
  const businessRules = resolveBusinessRules(knowledgeBase.businessRules, counters, possibleTensions);
  const stateTransitions = resolveStateTransitions(knowledgeBase.stateTransitions, counters);
  const crossDependencies = resolveDependencies(knowledgeBase.crossDependencies, counters);

  const resolvedKnowledgeBase = ProjectKnowledgeBaseSchema.parse({
    modules,
    businessRules,
    stateTransitions,
    glossary,
    crossDependencies,
  });
  possibleTensions.sort((first, second) =>
    compareProjectKnowledgeCanonicalText(first.category, second.category) ||
    compareProjectKnowledgeCanonicalText(first.subject, second.subject) ||
    compareProjectKnowledgeCanonicalText(first.entryKeys.join("\u0000"), second.entryKeys.join("\u0000")) ||
    compareProjectKnowledgeCanonicalText(first.reason, second.reason));
  counters.possibleTensionCount = possibleTensions.length;
  return { knowledgeBase: resolvedKnowledgeBase, counters, possibleTensions };
}

export function hasProjectKnowledgeDuplicateLogicalIdentities(knowledgeBaseInput: ProjectKnowledgeBase) {
  return countDuplicateLogicalIdentities(ProjectKnowledgeBaseSchema.parse(knowledgeBaseInput)) > 0;
}

function resolveAlwaysMergeCategory<TCategory extends "module" | "glossary">(
  category: TCategory,
  entries: TCategory extends "module"
    ? ProjectKnowledgeBase["modules"]
    : ProjectKnowledgeBase["glossary"],
  counters: ProjectKnowledgeDuplicateResolutionCounters,
) {
  const grouped = groupByLogicalIdentity(entries as unknown as Array<Record<string, unknown>>, (entry) =>
    category === "module" ? String(entry.id) : String(entry.term));
  const merged = Array.from(grouped.values()).flatMap((group) => {
    const sorted = sortCategoryEntries(category, group);
    if (sorted.length < 2) return sorted;
    counters.paraphraseMergeCount += sorted.length - 1;
    return [mergeProjectKnowledgeConflictEntries(category, sorted as never) as Record<string, unknown>];
  });
  return sortCategoryEntries(category, merged) as TCategory extends "module"
    ? ProjectKnowledgeBase["modules"]
    : ProjectKnowledgeBase["glossary"];
}

type BusinessRule = ProjectKnowledgeBase["businessRules"][number];
type StateTransition = ProjectKnowledgeBase["stateTransitions"][number];
type Dependency = ProjectKnowledgeBase["crossDependencies"][number];

type BusinessRuleInfo = {
  entry: BusinessRule;
  constraint: ProjectKnowledgeAtomicConstraint | null;
  fingerprint: string | null;
};

function resolveBusinessRules(
  entries: BusinessRule[],
  counters: ProjectKnowledgeDuplicateResolutionCounters,
  possibleTensions: ProjectKnowledgePossibleTension[],
) {
  const grouped = groupByLogicalIdentity(entries, (entry) => entry.id);
  const resolved: BusinessRule[] = [];
  const tensionIntents: Array<{ subject: string; entries: BusinessRule[]; reason: string }> = [];

  for (const [identity, group] of grouped) {
    const infos = sortCategoryEntries("business_rule", group).map((entry) => businessRuleInfo(entry, counters));
    if (infos.length < 2) {
      resolved.push(...infos.map((info) => info.entry));
      continue;
    }

    const clusters: BusinessRuleInfo[][] = [];
    for (const info of infos) {
      const matchingCluster = clusters.find((cluster) =>
        cluster.every((candidate) => isCompatibleProjectKnowledgeParaphrase(
          "business_rule",
          candidate.entry,
          info.entry,
        )));
      if (matchingCluster) matchingCluster.push(info);
      else clusters.push([info]);
    }

    const survivors = clusters.map((cluster) => {
      const clusterEntries = cluster.map((item) => item.entry);
      if (clusterEntries.length === 1) return clusterEntries[0]!;
      counters.paraphraseMergeCount += clusterEntries.length - 1;
      return mergeProjectKnowledgeConflictEntries("business_rule", clusterEntries);
    });
    if (survivors.length > 1 && !hasBusinessRuleContradiction(clusters)) {
      tensionIntents.push({
        subject: `identity:business_rule:${identity}`,
        entries: survivors,
        reason: businessRuleTensionReason(clusters),
      });
    }
    resolved.push(...survivors);
  }

  const rekeyed = rekeyCategory("business_rule", resolved, counters, (entry) => resolveBusinessRuleConstraint(entry));
  const replacementByEntry = rekeyed.replacements;
  for (const intent of tensionIntents) {
    possibleTensions.push({
      category: "business_rule",
      subject: intent.subject,
      entryKeys: intent.entries.map((entry) => (replacementByEntry.get(entry) ?? entry).id).sort(compareProjectKnowledgeCanonicalText),
      reason: intent.reason,
    });
  }
  return rekeyed.entries;
}

function businessRuleInfo(
  entry: BusinessRule,
  counters: ProjectKnowledgeDuplicateResolutionCounters,
): BusinessRuleInfo {
  const constraint = resolveBusinessRuleConstraint(entry);
  if (!constraint) counters.atomicExtractionFailureCount += 1;
  return {
    entry,
    constraint,
    fingerprint: constraint ? null : normalizeProjectKnowledgeRuleFingerprint(entry.rule),
  };
}

function resolveBusinessRuleConstraint(entry: BusinessRule) {
  const structured = ProjectKnowledgeAtomicConstraintSchema.safeParse(entry.constraint);
  return structured.success ? structured.data : extractAtomicConstraint(entry.rule);
}

function hasBusinessRuleContradiction(clusters: BusinessRuleInfo[][]) {
  for (let firstIndex = 0; firstIndex < clusters.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < clusters.length; secondIndex += 1) {
      const firstCluster = clusters[firstIndex] ?? [];
      const secondCluster = clusters[secondIndex] ?? [];
      for (const first of firstCluster) {
        for (const second of secondCluster) {
          if (!first.constraint || !second.constraint) continue;
          if (
            projectKnowledgeAtomicConstraintIdentity(first.constraint) ===
              projectKnowledgeAtomicConstraintIdentity(second.constraint) &&
            businessRulesShareAtomicModuleScope(first.entry, first.constraint, second.entry, second.constraint) &&
            compareProjectKnowledgeAtomicConstraintValues(first.constraint, second.constraint) === "contradiction"
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function businessRulesShareAtomicModuleScope(
  firstEntry: BusinessRule,
  firstConstraint: ProjectKnowledgeAtomicConstraint,
  secondEntry: BusinessRule,
  secondConstraint: ProjectKnowledgeAtomicConstraint,
) {
  const firstScopes = new Set(businessRuleAtomicModuleScopeIdentities(firstEntry, firstConstraint));
  return businessRuleAtomicModuleScopeIdentities(secondEntry, secondConstraint)
    .some((scope) => firstScopes.has(scope));
}

function businessRuleAtomicModuleScopeIdentities(
  entry: BusinessRule,
  constraint: ProjectKnowledgeAtomicConstraint,
) {
  const modules = [entry.moduleName, ...(entry.moduleAssociations ?? [])];
  return (modules.length ? modules : [undefined])
    .map((moduleName) => projectKnowledgeAtomicConstraintIdentity(constraint, moduleName));
}

function businessRuleTensionReason(clusters: BusinessRuleInfo[][]) {
  const representatives = clusters.map((cluster) => cluster[0]).filter((item): item is BusinessRuleInfo => Boolean(item));
  if (representatives.some((item) => !item.constraint)) {
    return representatives.every((item) => !item.constraint)
      ? "fingerprint_mismatch"
      : "atomic_extraction_uncertain";
  }
  return "different_atomic_identity";
}

function resolveStateTransitions(
  entries: StateTransition[],
  counters: ProjectKnowledgeDuplicateResolutionCounters,
) {
  const grouped = groupByLogicalIdentity(entries, (entry) => entry.id);
  const resolved: StateTransition[] = [];
  for (const group of grouped.values()) {
    const targetGroups = new Map<string, StateTransition[]>();
    sortCategoryEntries("state_transition", group).forEach((entry, index) => {
      const target = canonicalizeProjectKnowledgeLogicalIdentity(entry.toState);
      // An omitted target is unknown, so no two blank targets may merge.
      const key = target || `unknown-target-${index}`;
      const bucket = targetGroups.get(key) ?? [];
      bucket.push(entry);
      targetGroups.set(key, bucket);
    });
    for (const targetGroup of targetGroups.values()) {
      if (targetGroup.length === 1) resolved.push(targetGroup[0]!);
      else {
        counters.paraphraseMergeCount += targetGroup.length - 1;
        resolved.push(mergeProjectKnowledgeConflictEntries("state_transition", targetGroup));
      }
    }
  }
  return rekeyCategory("state_transition", resolved, counters).entries;
}

function resolveDependencies(
  entries: Dependency[],
  counters: ProjectKnowledgeDuplicateResolutionCounters,
) {
  const grouped = groupByLogicalIdentity(entries, (entry) => entry.id);
  const resolved: Dependency[] = [];
  for (const group of grouped.values()) {
    const clusters: Dependency[][] = [];
    for (const entry of sortCategoryEntries("dependency", group)) {
      const matchingCluster = clusters.find((cluster) =>
        cluster.every((candidate) => isCompatibleProjectKnowledgeParaphrase("dependency", candidate, entry)));
      if (matchingCluster) matchingCluster.push(entry);
      else clusters.push([entry]);
    }
    for (const cluster of clusters) {
      if (cluster.length === 1) resolved.push(cluster[0]!);
      else {
        counters.paraphraseMergeCount += cluster.length - 1;
        resolved.push(mergeProjectKnowledgeConflictEntries("dependency", cluster));
      }
    }
  }
  return rekeyCategory("dependency", resolved, counters).entries;
}

type RekeyableCategory = "business_rule" | "state_transition" | "dependency";
type RekeyableEntry = BusinessRule | StateTransition | Dependency;

function rekeyCategory<TEntry extends RekeyableEntry>(
  category: RekeyableCategory,
  entries: TEntry[],
  counters: ProjectKnowledgeDuplicateResolutionCounters,
  constraintFor?: (entry: TEntry) => ProjectKnowledgeAtomicConstraint | null,
) {
  const usedIdentities = new Set(entries.map((entry) => canonicalizeProjectKnowledgeLogicalIdentity(readEntryKey(category, entry))));
  const replacements = new Map<TEntry, TEntry>();
  for (const group of groupByLogicalIdentity(entries, (entry) => readEntryKey(category, entry)).values()) {
    if (group.length < 2) continue;
    const sorted = sortCategoryEntries(category, group) as TEntry[];
    const baseKey = readEntryKey(category, sorted[0]!);
    sorted.slice(1).forEach((entry) => {
      const businessRule = entry as BusinessRule;
      const constraint = category === "business_rule"
        ? constraintFor?.(entry)
        : null;
      const hashSeed = constraint
        ? projectKnowledgeAtomicConstraintIdentity(constraint, businessRule.moduleName)
        : rekeyProjection(category, entry);
      const suffix = hashCanonicalValue(hashSeed).slice(0, 8);
      let candidate = `${baseKey}-${suffix}`;
      let attempt = 2;
      while (usedIdentities.has(canonicalizeProjectKnowledgeLogicalIdentity(candidate))) {
        candidate = `${baseKey}-${suffix}-${attempt}`;
        attempt += 1;
      }
      usedIdentities.add(canonicalizeProjectKnowledgeLogicalIdentity(candidate));
      replacements.set(entry, writeEntryKey(category, entry, candidate) as TEntry);
      counters.rekeyCount += 1;
    });
  }
  const rekeyed = entries.map((entry) => replacements.get(entry) ?? entry);
  return { entries: sortCategoryEntries(category, rekeyed) as TEntry[], replacements };
}

function readEntryKey(category: RekeyableCategory, entry: RekeyableEntry) {
  switch (category) {
    case "business_rule":
    case "state_transition":
    case "dependency":
      return entry.id;
  }
}

function writeEntryKey(category: RekeyableCategory, entry: RekeyableEntry, key: string) {
  switch (category) {
    case "business_rule":
    case "state_transition":
    case "dependency":
      return { ...entry, id: key };
  }
}

function countDuplicateLogicalIdentities(knowledgeBase: ProjectKnowledgeBase) {
  return [
    duplicateCount(knowledgeBase.modules, (entry) => entry.id),
    duplicateCount(knowledgeBase.businessRules, (entry) => entry.id),
    duplicateCount(knowledgeBase.stateTransitions, (entry) => entry.id),
    duplicateCount(knowledgeBase.glossary, (entry) => entry.term),
    duplicateCount(knowledgeBase.crossDependencies, (entry) => entry.id),
  ].reduce((total, count) => total + count, 0);
}

function duplicateCount<TEntry>(entries: TEntry[], identity: (entry: TEntry) => string) {
  return Array.from(groupByLogicalIdentity(entries, identity).values())
    .reduce((count, group) => count + Math.max(0, group.length - 1), 0);
}

function groupByLogicalIdentity<TEntry>(entries: TEntry[], identity: (entry: TEntry) => string) {
  const grouped = new Map<string, TEntry[]>();
  for (const entry of entries) {
    const key = canonicalizeProjectKnowledgeLogicalIdentity(identity(entry));
    const bucket = grouped.get(key) ?? [];
    bucket.push(entry);
    grouped.set(key, bucket);
  }
  return grouped;
}

function sortCategoryEntries<TEntry>(category: ProjectKnowledgeConsolidationCategory, entries: TEntry[]) {
  return [...entries].sort((first, second) => {
    const firstKey = canonicalizeProjectKnowledgeLogicalIdentity(entryIdentity(category, first));
    const secondKey = canonicalizeProjectKnowledgeLogicalIdentity(entryIdentity(category, second));
    return compareProjectKnowledgeCanonicalText(firstKey, secondKey) ||
      compareProjectKnowledgeCanonicalText(
        hashCanonicalValue(rekeyProjection(category, first)),
        hashCanonicalValue(rekeyProjection(category, second)),
      ) ||
      compareProjectKnowledgeCanonicalText(entryIdentity(category, first), entryIdentity(category, second)) ||
      compareProjectKnowledgeCanonicalText(hashCanonicalValue(first), hashCanonicalValue(second));
  });
}

function entryIdentity(category: ProjectKnowledgeConsolidationCategory, entry: unknown) {
  const value = entry as Record<string, unknown>;
  return category === "glossary" ? String(value.term) : String(value.id);
}

/** Deliberately excludes IDs, evidence, constraints, and moduleAssociations. */
function rekeyProjection(category: ProjectKnowledgeConsolidationCategory, entry: unknown) {
  const value = entry as Record<string, unknown>;
  switch (category) {
    case "module":
      return { category, name: value.name, description: value.description };
    case "business_rule":
      return {
        category,
        rule: value.rule,
        sourceField: canonicalizeBusinessRuleSourceFieldForProjection(String(value.sourceField ?? "")),
        moduleName: value.moduleName ?? null,
      };
    case "state_transition":
      return {
        category,
        workflowName: value.workflowName,
        fromState: value.fromState ?? null,
        toState: value.toState ?? null,
        triggerOrCondition: value.triggerOrCondition,
        actor: value.actor ?? null,
        moduleName: value.moduleName ?? null,
      };
    case "glossary":
      return { category, type: value.type, definition: value.definition };
    case "dependency":
      return {
        category,
        sourceModule: value.sourceModule,
        targetModule: value.targetModule,
        dependencyType: value.dependencyType,
        description: value.description,
      };
  }
}
