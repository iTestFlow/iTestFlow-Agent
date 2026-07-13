import { describe, expect, it } from "vitest";

import { repairMissingProjectKnowledgeEvidenceRefs } from "./project-knowledge-evidence-repair";

const emptySections = {
  businessRules: [],
  stateTransitions: [],
  glossary: [],
  crossDependencies: [],
};

function moduleKnowledge(evidence: string, sourceWorkItemIds = ["42"]) {
  return {
    modules: [{
      id: "checkout",
      name: "Checkout",
      description: "Checkout flow",
      sourceWorkItemIds,
      evidence,
    }],
    ...emptySections,
  };
}

function snapshot(id: string, workItemId: string, fields: Record<string, unknown>) {
  return { id, sourceWorkItemId: workItemId, fields };
}

describe("repairMissingProjectKnowledgeEvidenceRefs", () => {
  it("repairs a unique exact fragment from the declared immutable source", () => {
    const result = repairMissingProjectKnowledgeEvidenceRefs({
      knowledgeBase: moduleKnowledge("Customers can complete checkout securely."),
      snapshots: [snapshot("snapshot-42", "42", {
        description: "Customers can complete checkout securely.",
      })],
    });

    expect(result).toMatchObject({
      attemptedEntryCount: 1,
      repairedEntryCount: 1,
      unresolvedEntryCount: 0,
    });
    expect(result.knowledgeBase.modules[0].evidenceRefs).toEqual([{
      sourceSnapshotId: "snapshot-42",
      sourceWorkItemId: "42",
      sourceField: "description",
      quote: "Customers can complete checkout securely.",
      origin: "generated_v2",
      verification: "exact",
    }]);
  });

  it("records a unique whitespace-normalized match without changing the quote", () => {
    const result = repairMissingProjectKnowledgeEvidenceRefs({
      knowledgeBase: moduleKnowledge("Customers can complete checkout securely."),
      snapshots: [snapshot("snapshot-42", "42", {
        description: "Customers can   complete checkout\nsecurely.",
      })],
    });

    expect(result.knowledgeBase.modules[0].evidenceRefs?.[0]).toMatchObject({
      verification: "normalized",
      quote: "Customers can complete checkout securely.",
    });
  });

  it("leaves duplicate matches unresolved instead of guessing", () => {
    const result = repairMissingProjectKnowledgeEvidenceRefs({
      knowledgeBase: moduleKnowledge("Checkout is secure."),
      snapshots: [snapshot("snapshot-42", "42", {
        title: "Checkout is secure.",
        description: "Checkout is secure.",
      })],
    });

    expect(result).toMatchObject({ repairedEntryCount: 0, unresolvedEntryCount: 1 });
    expect(result.knowledgeBase.modules[0].evidenceRefs).toBeUndefined();
  });

  it("requires every compatibility fragment to match uniquely", () => {
    const result = repairMissingProjectKnowledgeEvidenceRefs({
      knowledgeBase: moduleKnowledge("Supported fragment | Unsupported fragment"),
      snapshots: [snapshot("snapshot-42", "42", { description: "Supported fragment" })],
    });

    expect(result).toMatchObject({ repairedEntryCount: 0, unresolvedEntryCount: 1 });
    expect(result.knowledgeBase.modules[0].evidenceRefs).toBeUndefined();
  });

  it("preserves legacy backslashes while repairing evidence", () => {
    const quote = String.raw`Use \\server\share and regex \d+\|\w+`;
    const result = repairMissingProjectKnowledgeEvidenceRefs({
      knowledgeBase: moduleKnowledge(quote),
      snapshots: [snapshot("snapshot-42", "42", { description: quote })],
    });

    expect(result).toMatchObject({ repairedEntryCount: 1, unresolvedEntryCount: 0 });
    expect(result.knowledgeBase.modules[0].evidenceRefs?.[0].quote).toBe(quote);
  });

  it("never uses a snapshot from an undeclared work item", () => {
    const result = repairMissingProjectKnowledgeEvidenceRefs({
      knowledgeBase: moduleKnowledge("Checkout is secure."),
      snapshots: [snapshot("snapshot-99", "99", { description: "Checkout is secure." })],
    });

    expect(result).toMatchObject({ repairedEntryCount: 0, unresolvedEntryCount: 1 });
  });

  it("retains the stricter business-rule source-field allowlist", () => {
    const result = repairMissingProjectKnowledgeEvidenceRefs({
      knowledgeBase: {
        modules: [],
        businessRules: [{
          id: "paid-order",
          rule: "Only paid orders are confirmed.",
          sourceField: "acceptanceCriteria",
          sourceWorkItemIds: ["42"],
          evidence: "Paid",
        }],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      },
      snapshots: [snapshot("snapshot-42", "42", { state: "Paid" })],
    });

    expect(result).toMatchObject({ repairedEntryCount: 0, unresolvedEntryCount: 1 });
  });
});
