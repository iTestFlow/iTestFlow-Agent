import { describe, expect, it } from "vitest";

import { labelForScore, scoreFromFactors } from "./scoring.service";

describe("scoring service", () => {
  it("applies positive and negative factors and preserves their labels", () => {
    expect(scoreFromFactors({
      base: 75,
      positiveFactors: ["clear AC"],
      negativeFactors: ["missing edge case"],
    })).toEqual({
      value: 72,
      label: "Good / Minor review",
      explanation: "Score calculated from 1 positive factors and 1 negative factors.",
      factors: ["clear AC", "missing edge case"],
    });
  });

  it("defaults the base to 75 when no base is provided", () => {
    expect(scoreFromFactors({})).toEqual({
      value: 75,
      label: "Good / Minor review",
      explanation: "Score calculated from 0 positive factors and 0 negative factors.",
      factors: [],
    });
  });

  it("applies factors against the default base when base is omitted", () => {
    expect(scoreFromFactors({
      positiveFactors: ["a", "b"],
      negativeFactors: ["c"],
    })).toEqual({
      value: 76,
      label: "Good / Minor review",
      explanation: "Score calculated from 2 positive factors and 1 negative factors.",
      factors: ["a", "b", "c"],
    });
  });

  it("rounds and clamps scores", () => {
    expect(scoreFromFactors({ base: 99.8, positiveFactors: ["a"] }).value).toBe(100);
    expect(scoreFromFactors({ base: -20, negativeFactors: ["a"] }).value).toBe(0);
  });

  it.each([
    [85, "Excellent / Ready"],
    [70, "Good / Minor review"],
    [50, "Needs refinement"],
    [49, "Poor / Not ready"],
  ] as const)("labels %s", (score, label) => expect(labelForScore(score)).toBe(label));
});
