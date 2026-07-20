import { describe, expect, it } from "vitest";

import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import {
  addNameSimilarityIssues,
  areNamesSimilar,
  similarityKey,
} from "./project-knowledge-lint-similarity";

function evidenceRef(quote: string, sourceWorkItemId = "1"): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId: "s1",
    sourceWorkItemId,
    sourceField: "acceptanceCriteria",
    quote,
    origin: "generated_v4",
    verification: "exact",
  };
}

function moduleEntry(id: string, name: string, sourceWorkItemId = "1") {
  return { id, name, description: name, sourceWorkItemIds: [sourceWorkItemId], evidence: name, evidenceRefs: [evidenceRef(name, sourceWorkItemId)] };
}

function glossaryTerm(term: string, sourceWorkItemId = "1") {
  return { term, type: "term", definition: term, sourceWorkItemIds: [sourceWorkItemId], evidence: term, evidenceRefs: [evidenceRef(term, sourceWorkItemId)] };
}

function knowledgeBase(partial: Record<string, unknown>) {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
    ...partial,
  });
}

function collectIssues(base: ReturnType<typeof knowledgeBase>) {
  const issues: Parameters<typeof addNameSimilarityIssues>[1] = [];
  addNameSimilarityIssues(base, issues);
  return issues;
}

describe("project knowledge name similarity", () => {
  it("no longer flags substring/head-noun families that flooded the panel", () => {
    // Each pair reduces to overlap <= 1 after stopword stripping and used to
    // match only through the removed raw-substring branch.
    const floodPairs: Array<[string, string]> = [
      ["Payment Service", "Payment Receipt"],
      ["Customer Account Management", "customer"],
      ["Payment Outcome", "payment service"],
      ["Visitor Details Retrieval", "Visitor"],
      ["application", "Application state"],
    ];
    for (const [first, second] of floodPairs) {
      expect(areNamesSimilar(similarityKey(first), similarityKey(second))).toBe(false);
    }

    const base = knowledgeBase({
      modules: floodPairs.map(([first], index) => moduleEntry(`mod-${index}`, first)),
      glossary: floodPairs.map(([, second], index) => glossaryTerm(`${second}-${index}`)),
    });
    expect(collectIssues(base)).toEqual([]);
  });

  it("still flags a genuine near-duplicate name sharing most of its words", () => {
    const base = knowledgeBase({
      modules: [
        moduleEntry("mod-a", "Customer Account Management"),
        moduleEntry("mod-b", "Customer Account Mgmt"),
      ],
    });
    const issues = collectIssues(base);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      issueType: "similar_name",
      severity: "warning",
      category: "module",
      entryKey: "mod-a | mod-b",
    });
  });

  it("flags a cross-category near-duplicate with combined sources", () => {
    const base = knowledgeBase({
      modules: [moduleEntry("mod-visitor", "Visitor Details Retrieval", "10")],
      glossary: [glossaryTerm("Visitor Details Lookup", "20")],
    });
    const issues = collectIssues(base);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ category: "cross_category" });
    expect(issues[0].sourceWorkItemIds.sort()).toEqual(["10", "20"]);
  });

  it("skips identical canonical keys instead of flagging them", () => {
    // "Payment Service" and "Payment System" both reduce to "payment".
    const base = knowledgeBase({
      modules: [moduleEntry("mod-a", "Payment Service"), moduleEntry("mod-b", "Payment System")],
    });
    expect(collectIssues(base)).toEqual([]);
  });

  it("does not compare short canonical names below the length guard", () => {
    expect(areNamesSimilar("cart", "card")).toBe(false);
  });
});
