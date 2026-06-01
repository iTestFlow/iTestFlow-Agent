import type { TestSuite } from "@/modules/integrations/azure-devops/azure-devops-types";
import type {
  MigrationWarning,
  NormalizedSelectedSuiteRoot,
  RecursiveSuiteMigrationNode,
  SourceTestPointSnapshot,
  SuiteTreeNode,
} from "@/types/test-suite-migration";

export const supportedAzureOutcomeValues = new Set([
  "none",
  "passed",
  "failed",
  "inconclusive",
  "timeout",
  "aborted",
  "blocked",
  "notExecuted",
  "warning",
  "error",
  "notApplicable",
  "paused",
  "inProgress",
  "notImpacted",
]);

const outcomeAliases: Record<string, string> = {
  "not executed": "notExecuted",
  notexecuted: "notExecuted",
  "not applicable": "notApplicable",
  notapplicable: "notApplicable",
  "not impacted": "notImpacted",
  notimpacted: "notImpacted",
  "in progress": "inProgress",
  inprogress: "inProgress",
};

export function toSuiteTreeNodes(suites: TestSuite[], parentPath = ""): SuiteTreeNode[] {
  return suites.map((suite) => {
    const path = parentPath ? `${parentPath} / ${suite.name}` : suite.name;
    return {
      id: suite.id,
      name: suite.name,
      planId: suite.planId,
      parentSuiteId: suite.parentSuiteId,
      parentSuiteName: suite.parentSuiteName,
      suiteType: suite.suiteType,
      requirementId: suite.requirementId,
      queryString: suite.queryString,
      inheritDefaultConfigurations: suite.inheritDefaultConfigurations,
      defaultConfigurations: suite.defaultConfigurations,
      path,
      children: toSuiteTreeNodes(suite.children ?? [], path),
    };
  });
}

export function flattenSuiteTree(nodes: SuiteTreeNode[]): SuiteTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenSuiteTree(node.children)]);
}

export function findSuiteNode(nodes: SuiteTreeNode[], suiteId: string) {
  return flattenSuiteTree(nodes).find((node) => node.id === suiteId);
}

export function normalizeSelectedSuiteRoots(
  tree: SuiteTreeNode[],
  selectedSuiteIds: string[],
): {
  roots: NormalizedSelectedSuiteRoot[];
  warnings: MigrationWarning[];
  missingSuiteIds: string[];
} {
  const flat = flattenSuiteTree(tree);
  const nodeById = new Map(flat.map((node) => [node.id, node]));
  const parentById = new Map<string, string | undefined>();
  const walk = (node: SuiteTreeNode) => {
    for (const child of node.children) {
      parentById.set(child.id, node.id);
      walk(child);
    }
  };
  tree.forEach((node) => {
    parentById.set(node.id, node.parentSuiteId);
    walk(node);
  });

  const warnings: MigrationWarning[] = [];
  const missingSuiteIds: string[] = [];
  const seen = new Set<string>();
  const duplicateSelections = new Set<string>();
  const normalizedSelectedIds = selectedSuiteIds.filter((id) => {
    if (seen.has(id)) {
      duplicateSelections.add(id);
      return false;
    }
    seen.add(id);
    if (!nodeById.has(id)) {
      missingSuiteIds.push(id);
      return false;
    }
    return true;
  });

  duplicateSelections.forEach((suiteId) => {
    warnings.push({
      code: "duplicate-selection",
      severity: "warning",
      suiteId,
      message: `Suite ${suiteId} was selected more than once and will be counted once.`,
    });
  });

  const selected = new Set(normalizedSelectedIds);
  const skippedByRoot = new Map<string, string[]>();
  const roots = normalizedSelectedIds.filter((suiteId) => {
    const selectedAncestorId = findSelectedAncestor(suiteId, parentById, selected);
    if (!selectedAncestorId) return true;
    skippedByRoot.set(selectedAncestorId, [...(skippedByRoot.get(selectedAncestorId) ?? []), suiteId]);
    warnings.push({
      code: "parent-child-overlap",
      severity: "warning",
      suiteId,
      message: `Suite ${suiteId} is already included by selected parent suite ${selectedAncestorId}.`,
    });
    return false;
  });

  return {
    roots: roots
      .map((suiteId) => {
        const node = nodeById.get(suiteId);
        if (!node) return undefined;
        return {
          id: node.id,
          name: node.name,
          path: node.path,
          skippedDescendantSelections: skippedByRoot.get(node.id) ?? [],
        };
      })
      .filter((root): root is NormalizedSelectedSuiteRoot => Boolean(root))
      .sort((a, b) => a.path.localeCompare(b.path)),
    warnings,
    missingSuiteIds,
  };
}

export function collectIncludedSuites(tree: SuiteTreeNode[], roots: NormalizedSelectedSuiteRoot[]) {
  const rootIds = new Set(roots.map((root) => root.id));
  return flattenSuiteTree(tree).filter((node) => rootIds.has(node.id) || hasAncestorInSet(node.id, tree, rootIds));
}

export function planTargetSuites(input: {
  sourceTree: SuiteTreeNode[];
  targetTree: SuiteTreeNode[];
  selectedRoots: NormalizedSelectedSuiteRoot[];
  targetParentSuiteId: string;
}): { plannedSuites: RecursiveSuiteMigrationNode[]; warnings: MigrationWarning[] } {
  const warnings: MigrationWarning[] = [];
  const sourceById = new Map(flattenSuiteTree(input.sourceTree).map((suite) => [suite.id, suite]));
  const targetParent = findSuiteNode(input.targetTree, input.targetParentSuiteId);
  const targetParentPath = targetParent?.path ?? `Suite ${input.targetParentSuiteId}`;
  const existingRootNames = new Set((targetParent?.children ?? []).map((child) => normalizeName(child.name)));
  const planned: RecursiveSuiteMigrationNode[] = [];

  const rootNameState = new Set(existingRootNames);
  for (const root of input.selectedRoots) {
    const sourceRoot = sourceById.get(root.id);
    if (!sourceRoot) continue;
    addPlannedNode(sourceRoot, {
      targetParentPath,
      targetParentSuiteId: input.targetParentSuiteId,
      siblingNameState: rootNameState,
    });
  }

  return { plannedSuites: planned, warnings };

  function addPlannedNode(
    sourceNode: SuiteTreeNode,
    context: {
      targetParentPath: string;
      targetParentSuiteId?: string;
      targetParentSourceSuiteId?: string;
      siblingNameState: Set<string>;
    },
  ) {
    const targetSuiteName = safeSuiteName(sourceNode.name, context.siblingNameState);
    if (targetSuiteName !== sourceNode.name) {
      warnings.push({
        code: "suite-name-conflict",
        severity: "warning",
        suiteId: sourceNode.id,
        message: `Target suite name "${sourceNode.name}" conflicts under ${context.targetParentPath}; planned name is "${targetSuiteName}".`,
      });
    }
    const targetSuitePath = `${context.targetParentPath} / ${targetSuiteName}`;
    planned.push({
      sourceSuiteId: sourceNode.id,
      sourceSuitePath: sourceNode.path,
      sourceSuiteName: sourceNode.name,
      sourceParentSuiteId: sourceNode.parentSuiteId,
      targetSuiteName,
      targetSuitePath,
      targetParentSourceSuiteId: context.targetParentSourceSuiteId,
      targetParentSuiteId: context.targetParentSuiteId,
      suiteType: sourceNode.suiteType,
      requirementId: sourceNode.requirementId,
      queryString: sourceNode.queryString,
      inheritDefaultConfigurations: sourceNode.inheritDefaultConfigurations,
      defaultConfigurations: sourceNode.defaultConfigurations,
    });

    const childNameState = new Set<string>();
    for (const child of sourceNode.children) {
      addPlannedNode(child, {
        targetParentPath: targetSuitePath,
        targetParentSourceSuiteId: sourceNode.id,
        siblingNameState: childNameState,
      });
    }
  }
}

export function normalizeOutcomeForAzure(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const direct = [...supportedAzureOutcomeValues].find((outcome) => outcome.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  if (direct) return direct;
  return outcomeAliases[trimmed.replace(/[_-]+/g, " ").toLocaleLowerCase()] ?? outcomeAliases[trimmed.toLocaleLowerCase()];
}

export function outcomeCategory(value?: string) {
  const normalized = normalizeOutcomeForAzure(value);
  if (!normalized) return "No source outcome";
  const labels: Record<string, string> = {
    none: "Not Executed",
    passed: "Passed",
    failed: "Failed",
    inconclusive: "Inconclusive",
    timeout: "Timeout",
    aborted: "Aborted",
    blocked: "Blocked",
    notExecuted: "Not Executed",
    warning: "Warning",
    error: "Error",
    notApplicable: "Not Applicable",
    paused: "Paused",
    inProgress: "In Progress",
    notImpacted: "Not Impacted",
  };
  return labels[normalized] ?? "Other supported Azure DevOps outcome";
}

export function hasActionableOutcome(point: SourceTestPointSnapshot) {
  const normalized = normalizeOutcomeForAzure(point.latestOutcome);
  return Boolean(normalized && normalized !== "none" && normalized !== "notExecuted");
}

export function targetOutcomeExists(outcome?: string) {
  const normalized = normalizeOutcomeForAzure(outcome);
  return Boolean(normalized && normalized !== "none" && normalized !== "notExecuted");
}

export function pointMatchKey(suiteId: string | undefined, testCaseId: string | undefined, configurationId: string | undefined) {
  return `${suiteId ?? ""}::${testCaseId ?? ""}::${configurationId ?? ""}`;
}

function findSelectedAncestor(suiteId: string, parentById: Map<string, string | undefined>, selected: Set<string>) {
  let parentId = parentById.get(suiteId);
  while (parentId) {
    if (selected.has(parentId)) return parentId;
    parentId = parentById.get(parentId);
  }
  return undefined;
}

function hasAncestorInSet(suiteId: string, tree: SuiteTreeNode[], ancestorIds: Set<string>) {
  const parentById = new Map<string, string | undefined>();
  const walk = (node: SuiteTreeNode) => {
    for (const child of node.children) {
      parentById.set(child.id, node.id);
      walk(child);
    }
  };
  tree.forEach(walk);
  let parentId = parentById.get(suiteId);
  while (parentId) {
    if (ancestorIds.has(parentId)) return true;
    parentId = parentById.get(parentId);
  }
  return false;
}

function safeSuiteName(name: string, usedNormalizedNames: Set<string>) {
  if (!usedNormalizedNames.has(normalizeName(name))) {
    usedNormalizedNames.add(normalizeName(name));
    return name;
  }

  let counter = 1;
  while (true) {
    const suffix = counter === 1 ? " - Migrated" : ` - Migrated ${counter}`;
    const candidate = `${name}${suffix}`;
    const normalized = normalizeName(candidate);
    if (!usedNormalizedNames.has(normalized)) {
      usedNormalizedNames.add(normalized);
      return candidate;
    }
    counter += 1;
  }
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
