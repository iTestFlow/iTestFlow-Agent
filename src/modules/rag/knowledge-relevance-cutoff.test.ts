import { describe, expect, it } from "vitest";

import { ontologyEntryId, type OntologyCategory } from "@/modules/rag/knowledge-ontology";
import {
  hasAnyRelevantEntry,
  selectRelevantEntries,
  type ScoredEntry,
} from "@/modules/rag/knowledge-relevance-cutoff";

/**
 * The similarity figures below were measured with the pinned local embedding model
 * against a real compiled knowledge base — a few hundred entries, dominated by business
 * rules with a long glossary tail — for three work items of different shapes. Synthetic
 * numbers would prove only that the arithmetic runs; these encode the distributions that
 * actually produced bad selections.
 */

function entries(
  category: OntologyCategory,
  similarities: number[],
  prefix: string,
): ScoredEntry[] {
  return similarities.map((similarity, index) => ({
    key: `${prefix}-${index + 1}`,
    category,
    similarity,
  }));
}

/** Rebuilds a category's full spread from its measured head, size and floor. */
function withTail(head: number[], options: { count: number; min: number }): number[] {
  const tailLength = options.count - head.length;
  const from = head[head.length - 1];
  return [
    ...head,
    ...Array.from({ length: tailLength }, (_, index) =>
      from - ((from - options.min) * (index + 1)) / tailLength,
    ),
  ];
}

/** A defect whose category spreads are typical: one clear module, a long rule tail. */
function typicalKnowledgeBase(): ScoredEntry[] {
  return [
    ...entries("businessRules", withTail(
      [0.769, 0.756, 0.755, 0.739, 0.706, 0.705, 0.697, 0.682], { count: 114, min: 0.465 },
    ), "rule"),
    ...entries("modules", withTail(
      [0.723, 0.651, 0.619, 0.617, 0.609, 0.605, 0.603, 0.600], { count: 39, min: 0.495 },
    ), "mod"),
    ...entries("stateTransitions",
      [0.678, 0.662, 0.634, 0.633, 0.623, 0.615, 0.603, 0.595, 0.590, 0.579], "st"),
    ...entries("glossary", withTail(
      [0.657, 0.598, 0.586, 0.583, 0.581], { count: 48, min: 0.456 },
    ), "term"),
    ...entries("crossDependencies", [0.586, 0.567], "dep"),
  ];
}

const NOTHING_CONNECTED = new Map<string, number>();

describe("selectRelevantEntries", () => {
  it("rejects a category whose every entry is unrelated", () => {
    // This board has exactly two module dependencies and neither relates to the work
    // item. Both top their own category purely because there is nothing else in it — a
    // per-category bar cannot see that, a global one can.
    const selection = selectRelevantEntries(typicalKnowledgeBase(), NOTHING_CONNECTED);

    expect(selection.crossDependencies).toEqual([]);
  });

  it("emits an explicit empty array for a scored category with no survivors, and no key for one never scored", () => {
    // The renderer reads a present-but-empty array as "ranked, send nothing" and an
    // absent key as "not ranked, keep keyword ranking". A fully-cut category must be
    // the former — otherwise keyword fallback re-admits what the cutoff rejected.
    const selection = selectRelevantEntries(typicalKnowledgeBase(), NOTHING_CONNECTED);

    expect("crossDependencies" in selection).toBe(true);
    expect(selection.crossDependencies).toEqual([]);
    // typicalKnowledgeBase() contains no chatInsights entries at all.
    expect("chatInsights" in selection).toBe(false);
  });

  it("keeps the one module the work item is about and drops the tail", () => {
    // One module the defect is actually in, then a tail of five the defect does not
    // touch. Naming them asserts a relationship that is not there.
    const selection = selectRelevantEntries(typicalKnowledgeBase(), NOTHING_CONNECTED);

    expect(selection.modules).toEqual(["mod-1"]);
  });

  it("stays generous with business rules, which are the test conditions", () => {
    const selection = selectRelevantEntries(typicalKnowledgeBase(), NOTHING_CONNECTED);

    // Bounded rather than exact: the fixture interpolates each category's tail from its
    // measured head, size and floor, so the count tracks the real selection's shape
    // without reproducing it entry for entry.
    expect(selection.businessRules?.length).toBeGreaterThan(5);
    expect(selection.businessRules?.length).toBeLessThan(20);
  });

  it("does not need a per-category rule to be strict about modules and lenient about rules", () => {
    // Both fall out of one global bar applied to the project's own spread: rules
    // occupy the top of it, the module tail does not.
    const selection = selectRelevantEntries(typicalKnowledgeBase(), NOTHING_CONNECTED);

    expect(selection.businessRules?.length).toBeGreaterThan((selection.modules ?? []).length);
  });

  describe("structural connection", () => {
    it("keeps an entry the ontology connects even when similarity would drop it", () => {
      // Measured on a work item whose owning module scored 0.710 against a global bar
      // of ~0.72. Similarity alone discarded the single most relevant module while
      // keeping rules from unrelated parts of the board.
      const scored: ScoredEntry[] = [
        ...entries("businessRules", withTail([0.848, 0.782, 0.777, 0.763], { count: 114, min: 0.530 }), "rule"),
        ...entries("modules", withTail([0.710, 0.625, 0.623], { count: 39, min: 0.518 }), "mod"),
      ];
      const withoutOntology = selectRelevantEntries(scored, NOTHING_CONNECTED);
      const withOntology = selectRelevantEntries(
        scored,
        new Map([[ontologyEntryId("modules", "mod-1"), 0]]),
      );

      expect(withoutOntology.modules).toEqual([]);
      expect(withOntology.modules).toEqual(["mod-1"]);
    });

    it("keeps a dependency the graph reaches, however far down it scores", () => {
      // The inverse of the first test. Nothing about the entry changed — only whether
      // the project's graph says the work item's module depends on it.
      const scored = typicalKnowledgeBase();
      const reachedByGraph = new Map([[ontologyEntryId("crossDependencies", "dep-1"), 2]]);

      expect(selectRelevantEntries(scored, reachedByGraph).crossDependencies).toEqual(["dep-1"]);
    });

    it("orders by similarity, not by hop distance", () => {
      // Connection decides membership; it does not claim a distant entry is a better
      // match than a close one.
      const scored: ScoredEntry[] = entries("businessRules", [0.80, 0.50], "rule");
      const connected = new Map([[ontologyEntryId("businessRules", "rule-2"), 0]]);

      expect(selectRelevantEntries(scored, connected).businessRules).toEqual(["rule-1", "rule-2"]);
    });
  });

  it("returns nothing for an empty knowledge base", () => {
    expect(selectRelevantEntries([], NOTHING_CONNECTED)).toEqual({});
  });
});

describe("hasAnyRelevantEntry", () => {
  it("is false only when every category came back empty", () => {
    expect(hasAnyRelevantEntry({ modules: [], businessRules: [] })).toBe(false);
    expect(hasAnyRelevantEntry({ modules: [], businessRules: ["rule-1"] })).toBe(true);
    expect(hasAnyRelevantEntry({})).toBe(false);
  });
});
