import { describe, expect, it } from "vitest";

import {
  areProjectKnowledgeDependencyTypesEquivalent,
  areProjectKnowledgeDependencyTypesHierarchyCompatible,
  canonicalizeProjectKnowledgeDependencyType,
  mostSpecificProjectKnowledgeDependencyType,
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

  it("models only the generic-to-service hierarchy as type-compatible", () => {
    expect(areProjectKnowledgeDependencyTypesHierarchyCompatible(
      "dependency",
      "external service dependency",
    )).toBe(true);
    expect(areProjectKnowledgeDependencyTypesHierarchyCompatible(
      "service dependency",
      "external service dependency",
    )).toBe(true);
    expect(areProjectKnowledgeDependencyTypesHierarchyCompatible("dependency", "API call")).toBe(true);
    expect(areProjectKnowledgeDependencyTypesHierarchyCompatible("API call", "event dependency")).toBe(false);
    expect(areProjectKnowledgeDependencyTypesHierarchyCompatible(
      "API call",
      "external service dependency",
    )).toBe(false);
  });

  it("chooses the most-specific hierarchy type independent of input order", () => {
    expect(mostSpecificProjectKnowledgeDependencyType("dependency", "API call")).toBe("api dependency");
    expect(mostSpecificProjectKnowledgeDependencyType(
      "service dependency",
      "external service dependency",
    )).toBe("external service dependency");
    expect(mostSpecificProjectKnowledgeDependencyType(
      "external service dependency",
      "service dependency",
    )).toBe("external service dependency");
  });

  it("requires identical evidence before hierarchy-only equivalence", () => {
    expect(areProjectKnowledgeDependencyTypesEquivalent(
      "dependency",
      "external service dependency",
    )).toBe(false);
    expect(areProjectKnowledgeDependencyTypesEquivalent(
      "dependency",
      "external service dependency",
      { identicalEvidence: true },
    )).toBe(true);
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
