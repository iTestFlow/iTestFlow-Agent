import { describe, expect, it } from "vitest";

import {
  areProjectKnowledgeDependencyTypesEquivalent,
  canonicalizeProjectKnowledgeDependencyType,
  projectKnowledgeDependencyTypeSubject,
} from "./project-knowledge-dependency-type";

describe("project knowledge dependency type canonicalization", () => {
  it.each([
    ["external service call", "external service dependency"],
    ["External-Service Dependency", "external service dependency"],
    ["third-party API call", "external service dependency"],
    ["API call", "api dependency"],
    ["REST API dependency", "api dependency"],
    ["calls", "service dependency"],
    ["uses", "dependency"],
    ["event-based integration", "event dependency"],
    ["---", "dependency"],
  ])("canonicalizes %s to %s", (input, expected) => {
    expect(canonicalizeProjectKnowledgeDependencyType(input)).toBe(expected);
  });

  it("keeps materially different transports separate", () => {
    expect(areProjectKnowledgeDependencyTypesEquivalent("API call", "event dependency")).toBe(false);
  });

  it("uses identical evidence only to merge labels with the same remaining subject", () => {
    expect(projectKnowledgeDependencyTypeSubject("payment gateway call")).toBe("payment gateway");
    expect(areProjectKnowledgeDependencyTypesEquivalent(
      "payment gateway call",
      "payment gateway dependency",
      { identicalEvidence: true },
    )).toBe(true);
    expect(areProjectKnowledgeDependencyTypesEquivalent(
      "payment gateway call",
      "inventory event",
      { identicalEvidence: true },
    )).toBe(false);
  });
});
