import { describe, expect, it } from "vitest";

import {
  getContextSuggestionCandidatePoolSize,
  getContextSuggestionFinalLimit,
} from "./context-suggestion-sizing";

describe("context suggestion sizing", () => {
  it.each([
    [1, 1, 40],
    [8, 8, 40],
    [12, 12, 60],
    [25, 25, 100],
  ])("uses retrieval top-K %i as the final suggestion limit", (topK, finalLimit, candidatePoolSize) => {
    expect(getContextSuggestionFinalLimit(topK)).toBe(finalLimit);
    expect(getContextSuggestionCandidatePoolSize(topK)).toBe(candidatePoolSize);
  });

  it("keeps final limits and candidate pools inside supported bounds", () => {
    expect(getContextSuggestionFinalLimit(0)).toBe(1);
    expect(getContextSuggestionCandidatePoolSize(0)).toBe(40);
    expect(getContextSuggestionFinalLimit(1000)).toBe(25);
    expect(getContextSuggestionCandidatePoolSize(1000)).toBe(100);
  });
});
