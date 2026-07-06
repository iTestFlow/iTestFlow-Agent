import { describe, expect, it } from "vitest";

import type { SuiteTreeNode } from "@/types/test-suite-migration";

import {
  filterSuiteTree,
  flattenTree,
  formatSelectedPlan,
  isStaticSuite,
  normalizeSearch,
  suiteMatches,
} from "./suite-tree";

function makeSuite(id: string, overrides: Partial<SuiteTreeNode> = {}): SuiteTreeNode {
  return {
    id,
    name: `Suite ${id}`,
    planId: "plan-1",
    suiteType: "staticTestSuite",
    path: `Plan/Suite ${id}`,
    children: [],
    ...overrides,
  };
}

// root -> [Regression -> [Payments Smoke], Sanity]
function makeTree(): SuiteTreeNode[] {
  return [
    makeSuite("1", {
      name: "Release",
      children: [
        makeSuite("2", {
          name: "Regression",
          children: [makeSuite("3", { name: "Payments Smoke" })],
        }),
        makeSuite("4", { name: "Sanity" }),
      ],
    }),
  ];
}

function shapeOf(nodes: SuiteTreeNode[]): unknown[] {
  return nodes.map((node) => ({ id: node.id, children: shapeOf(node.children) }));
}

describe("filterSuiteTree", () => {
  it("returns the input tree unchanged for empty or whitespace-only search", () => {
    const tree = makeTree();
    expect(filterSuiteTree(tree, "")).toBe(tree);
    expect(filterSuiteTree(tree, "   ")).toBe(tree);
  });

  it("keeps the full ancestor chain of a nested match and prunes unmatched siblings", () => {
    const result = filterSuiteTree(makeTree(), "payments");
    expect(shapeOf(result)).toEqual([
      { id: "1", children: [{ id: "2", children: [{ id: "3", children: [] }] }] },
    ]);
  });

  it("prunes unmatched children even when their parent matches", () => {
    const result = filterSuiteTree(makeTree(), "regression");
    expect(shapeOf(result)).toEqual([
      { id: "1", children: [{ id: "2", children: [] }] },
    ]);
  });

  it("matches case- and whitespace-insensitively on both query and suite fields", () => {
    const tree = [makeSuite("1", { name: "Payments   Smoke" })];
    expect(filterSuiteTree(tree, "  PAYMENTS smoke ")).toHaveLength(1);
    expect(filterSuiteTree(tree, "checkout")).toHaveLength(0);
  });

  it("does not mutate the input tree", () => {
    const tree = makeTree();
    filterSuiteTree(tree, "payments");
    expect(shapeOf(tree)).toEqual(shapeOf(makeTree()));
  });
});

describe("suiteMatches", () => {
  it("matches on id, name, path, suiteType, and requirementId", () => {
    const node = makeSuite("42", {
      name: "Login",
      path: "Plan/Auth/Login",
      suiteType: "requirementTestSuite",
      requirementId: "REQ-7",
    });
    expect(suiteMatches(node, "42")).toBe(true);
    expect(suiteMatches(node, "login")).toBe(true);
    expect(suiteMatches(node, "plan/auth")).toBe(true);
    expect(suiteMatches(node, "requirementtestsuite")).toBe(true);
    expect(suiteMatches(node, "req-7")).toBe(true);
    expect(suiteMatches(node, "checkout")).toBe(false);
  });

  it("skips absent optional fields", () => {
    const node = makeSuite("1", { suiteType: undefined, requirementId: undefined });
    expect(suiteMatches(node, "req")).toBe(false);
  });
});

describe("normalizeSearch", () => {
  it("trims, collapses internal whitespace, and lowercases", () => {
    expect(normalizeSearch("  Payments \t\n  Smoke  ")).toBe("payments smoke");
    expect(normalizeSearch("")).toBe("");
  });
});

describe("isStaticSuite", () => {
  it("classifies static suites only", () => {
    expect(isStaticSuite(makeSuite("1", { suiteType: "staticTestSuite" }))).toBe(true);
    expect(isStaticSuite(makeSuite("2", { suiteType: "requirementTestSuite" }))).toBe(false);
    expect(isStaticSuite(makeSuite("3", { suiteType: "dynamicTestSuite" }))).toBe(false);
    expect(isStaticSuite(makeSuite("4", { suiteType: undefined }))).toBe(false);
  });
});

describe("flattenTree", () => {
  it("preserves depth-first order across roots", () => {
    const tree = [...makeTree(), makeSuite("5", { name: "Second Root" })];
    expect(flattenTree(tree).map((node) => node.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns an empty list for an empty tree", () => {
    expect(flattenTree([])).toEqual([]);
  });
});

describe("formatSelectedPlan", () => {
  it("formats a known plan as 'id - name'", () => {
    const plans = [
      { id: "10", name: "Sprint 1" },
      { id: "20", name: "Sprint 2" },
    ];
    expect(formatSelectedPlan(plans, "20")).toBe("20 - Sprint 2");
  });

  it("returns undefined for unknown or empty ids", () => {
    const plans = [{ id: "10", name: "Sprint 1" }];
    expect(formatSelectedPlan(plans, "99")).toBeUndefined();
    expect(formatSelectedPlan(plans, "")).toBeUndefined();
  });
});
