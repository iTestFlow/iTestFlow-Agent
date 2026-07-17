import { describe, expect, it } from "vitest";

import { MIN_TRIGRAM_QUERY_LENGTH, prepareTrigramQuery } from "./trigram-search";

describe("prepareTrigramQuery", () => {
  it("trims, collapses internal whitespace, and lowercases", () => {
    expect(prepareTrigramQuery("  Workflow   Approval  ")).toBe("workflow approval");
  });

  it("returns null below the minimum trigram length", () => {
    expect(prepareTrigramQuery("ab")).toBeNull();
    expect(prepareTrigramQuery("  a  ")).toBeNull();
    expect(prepareTrigramQuery("")).toBeNull();
    expect(prepareTrigramQuery("   ")).toBeNull();
  });

  it("keeps queries at exactly the minimum length", () => {
    const query = "a".repeat(MIN_TRIGRAM_QUERY_LENGTH);
    expect(prepareTrigramQuery(query)).toBe(query);
  });

  it("does not tokenize or strip punctuation, unlike buildFtsQuery", () => {
    // Trigram matching wants the natural phrase, not a boolean-operator query.
    expect(prepareTrigramQuery("flow-chart!")).toBe("flow-chart!");
  });
});
