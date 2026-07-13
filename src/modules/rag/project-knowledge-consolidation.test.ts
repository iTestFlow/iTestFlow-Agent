import { describe, expect, it } from "vitest";

import type { ProjectKnowledgeBase, ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import { mergeProjectKnowledgeConflictEntries } from "./project-knowledge-consolidation";

function evidenceRef(
  sourceWorkItemId: string,
  sourceSnapshotId: string,
  quote: string,
): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId,
    sourceWorkItemId,
    sourceField: "description",
    quote,
    origin: "generated_v2",
    verification: "exact",
  };
}

describe("mergeProjectKnowledgeConflictEntries", () => {
  it("uses deterministic module semantics and unions evidence provenance", () => {
    const entries: ProjectKnowledgeBase["modules"] = [
      {
        id: "mod-checkout",
        name: "Checkout",
        description: "Handles checkout.",
        sourceWorkItemIds: ["10"],
        evidence: "Checkout exists.",
        evidenceRefs: [evidenceRef("10", "snapshot-10", "Checkout exists.")],
      },
      {
        id: "MOD_CHECKOUT",
        name: "Checkout and payment",
        description: "Handles checkout, payment, and confirmation.",
        sourceWorkItemIds: ["11"],
        evidence: "Payment is collected during checkout.",
        evidenceRefs: [evidenceRef("11", "snapshot-11", "Payment is collected during checkout.")],
      },
    ];

    const merged = mergeProjectKnowledgeConflictEntries("module", entries);

    expect(merged).toEqual({
      id: "mod-checkout",
      name: "Checkout and payment",
      description: "Handles checkout, payment, and confirmation.",
      sourceWorkItemIds: ["10", "11"],
      evidence: "Checkout exists. | Payment is collected during checkout.",
      evidenceRefs: [
        evidenceRef("10", "snapshot-10", "Checkout exists."),
        evidenceRef("11", "snapshot-11", "Payment is collected during checkout."),
      ],
    });
  });

  it("applies the glossary preference policy while retaining all sources", () => {
    const entries: ProjectKnowledgeBase["glossary"] = [
      {
        term: "Customer",
        type: "term",
        definition: "A buyer.",
        sourceWorkItemIds: ["10"],
        evidence: "Customer buys.",
      },
      {
        term: "Customer",
        type: "business_entity",
        definition: "A person or organization that buys products.",
        sourceWorkItemIds: ["11"],
        evidence: "Customer owns an order.",
      },
    ];

    expect(mergeProjectKnowledgeConflictEntries("glossary", entries)).toEqual({
      term: "Customer",
      type: "business_entity",
      definition: "A person or organization that buys products.",
      sourceWorkItemIds: ["10", "11"],
      evidence: "Customer buys. | Customer owns an order.",
      evidenceRefs: undefined,
    });
  });
});
