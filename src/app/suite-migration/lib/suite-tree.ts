import type { SuiteTreeNode } from "@/types/test-suite-migration";

/* --------------------------------------------------------------------------
 * Pure helpers for the suite-migration tree pickers: search filtering that
 * keeps ancestor chains intact, depth-first flattening for selection
 * bookkeeping, and display formatting. No backend calls — operates on trees
 * already held in component state.
 * ------------------------------------------------------------------------ */

export type TestPlan = {
  id: string;
  name: string;
};

export function filterSuiteTree(nodes: SuiteTreeNode[], search: string): SuiteTreeNode[] {
  const query = normalizeSearch(search);
  if (!query) return nodes;

  return nodes
    .map((node) => {
      const children = filterSuiteTree(node.children, search);
      if (suiteMatches(node, query) || children.length) {
        return { ...node, children };
      }
      return undefined;
    })
    .filter((node): node is SuiteTreeNode => Boolean(node));
}

export function suiteMatches(node: SuiteTreeNode, normalizedQuery: string) {
  return [
    node.id,
    node.name,
    node.path,
    node.suiteType,
    node.requirementId,
  ]
    .filter(Boolean)
    .some((value) => normalizeSearch(String(value)).includes(normalizedQuery));
}

export function normalizeSearch(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function isStaticSuite(suite: SuiteTreeNode) {
  return suite.suiteType === "staticTestSuite";
}

export function formatSelectedPlan(plans: TestPlan[], planId: string) {
  const plan = plans.find((candidate) => candidate.id === planId);
  return plan ? `${plan.id} - ${plan.name}` : undefined;
}

export function flattenTree(nodes: SuiteTreeNode[]): SuiteTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

export function descendantSuiteIds(node: SuiteTreeNode) {
  return flattenTree(node.children).map((child) => child.id);
}

export function suiteSelectionState(
  node: SuiteTreeNode,
  selectedIds: readonly string[],
  selectedAncestorId?: string,
): true | false | "indeterminate" {
  if (selectedAncestorId || selectedIds.includes(node.id)) return true;
  const selected = new Set(selectedIds);
  return descendantSuiteIds(node).some((id) => selected.has(id)) ? "indeterminate" : false;
}

export function toggleSuiteSelection(
  node: SuiteTreeNode,
  selectedIds: readonly string[],
  checked: boolean,
) {
  const next = new Set(selectedIds);
  if (checked) {
    next.add(node.id);
    descendantSuiteIds(node).forEach((id) => next.delete(id));
  } else {
    next.delete(node.id);
  }
  return [...next];
}
