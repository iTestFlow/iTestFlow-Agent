import type { TestSuite } from "@/modules/integrations/core/integration-types";

export function selectedSuiteIds(tree: TestSuite[], selectedId: string): string[] {
  function find(suites: TestSuite[]): TestSuite | undefined {
    for (const suite of suites) {
      if (suite.id === selectedId) return suite;
      const nested = find(suite.children ?? []);
      if (nested) return nested;
    }
    return undefined;
  }
  const selected = find(tree);
  if (!selected) throw new Error(`Test suite ${selectedId} was not found in the selected Test Plan.`);
  const ids: string[] = [];
  function visit(suite: TestSuite) {
    ids.push(suite.id);
    for (const child of suite.children ?? []) visit(child);
  }
  visit(selected);
  return [...new Set(ids)];
}
