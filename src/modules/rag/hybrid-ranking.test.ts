import { describe, expect, it } from "vitest";

import { cosineSimilarity, fuseByReciprocalRank } from "./hybrid-ranking";

describe("cosineSimilarity", () => {
  it("computes known similarities", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2);
  });

  it("is scale invariant", () => {
    expect(cosineSimilarity([2, 4, 6], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 0 for empty, mismatched-dimension, or zero-norm vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });
});

describe("fuseByReciprocalRank", () => {
  const getKey = (item: { id: string }) => item.id;

  it("ranks an item found by both retrievers above single-list front-runners", () => {
    // "b" is mid-list in both; "a" and "c" each lead one list only.
    // 1/(60+2) + 1/(60+2) > 1/(60+1), so agreement wins.
    const fused = fuseByReciprocalRank({
      lists: [
        [{ id: "a" }, { id: "b" }, { id: "d" }],
        [{ id: "c" }, { id: "b" }],
      ],
      getKey,
    });
    expect(fused.map((result) => result.item.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("keeps the first list occurrence as the returned item instance", () => {
    const fused = fuseByReciprocalRank({
      lists: [
        [{ id: "x", origin: "lexical" }],
        [{ id: "x", origin: "semantic" }],
      ],
      getKey,
    });
    expect(fused).toHaveLength(1);
    expect(fused[0]!.item).toMatchObject({ origin: "lexical" });
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 61);
  });

  it("breaks score ties by first appearance for deterministic output", () => {
    const fused = fuseByReciprocalRank({
      lists: [[{ id: "first" }], [{ id: "second" }]],
      getKey,
    });
    expect(fused.map((result) => result.item.id)).toEqual(["first", "second"]);
  });

  it("skips items with empty keys and honors a custom k", () => {
    const fused = fuseByReciprocalRank({
      lists: [[{ id: "" }, { id: "a" }]],
      getKey,
      k: 1,
    });
    expect(fused).toHaveLength(1);
    // "a" is rank 2 in its list: 1 / (1 + 2).
    expect(fused[0]!.score).toBeCloseTo(1 / 3);
  });

  it("returns an empty result for empty input lists", () => {
    expect(fuseByReciprocalRank({ lists: [], getKey })).toEqual([]);
    expect(fuseByReciprocalRank({ lists: [[], []], getKey })).toEqual([]);
  });
});
