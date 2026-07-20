import { describe, expect, it } from "vitest";

import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import { verifyProjectKnowledgeEvidence } from "./project-knowledge-provenance";

const ref = (overrides: Partial<ProjectKnowledgeEvidenceRef> = {}): ProjectKnowledgeEvidenceRef => ({
  sourceSnapshotId: "snapshot-1",
  sourceWorkItemId: "42",
  sourceField: "description",
  quote: "Customer submits the order",
  origin: "generated_v2",
  verification: "exact",
  ...overrides,
});

function knowledge(evidenceRef: ProjectKnowledgeEvidenceRef) {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "mod-order",
      name: "Order",
      description: "Order handling.",
      sourceWorkItemIds: [evidenceRef.sourceWorkItemId],
      evidence: evidenceRef.quote,
      evidenceRefs: [evidenceRef],
    }],
  });
}

function verify(evidenceRef: ProjectKnowledgeEvidenceRef, fields: Record<string, unknown>) {
  return verifyProjectKnowledgeEvidence({
    knowledgeBase: knowledge(evidenceRef),
    snapshots: [{ id: "snapshot-1", sourceWorkItemId: "42", fields }],
  });
}

describe("immutable evidence verification", () => {
  it("accepts exact and whitespace-normalized quotes in the strict field", () => {
    const exact = verify(ref(), { description: "Before. Customer submits the order. After." });
    expect(exact.blockers).toEqual([]);
    expect(exact.knowledgeBase.modules[0].evidenceRefs?.[0].verification).toBe("exact");

    const normalized = verify(ref({ quote: "Customer   submits\n the order" }), {
      description: "Customer submits the order",
    });
    expect(normalized.blockers).toEqual([]);
    expect(normalized.knowledgeBase.modules[0].evidenceRefs?.[0].verification).toBe("normalized");
  });

  it("auto-reanchors a unique token sequence and replaces the quote with source text", () => {
    const result = verify(ref({ quote: "customer submits order" }), {
      description: "When ready, Customer submits the Order; confirmation follows.",
    });
    expect(result.blockers).toEqual([]);
    expect(result.counts.autoReanchored).toBe(1);
    expect(result.knowledgeBase.modules[0].evidenceRefs?.[0]).toMatchObject({
      quote: "Customer submits the Order",
      verification: "auto_reanchored",
    });
  });

  it("blocks ambiguous or missing new-v2 evidence without searching another field", () => {
    const ambiguous = verify(ref({ quote: "customer submits order" }), {
      title: "Customer submits order",
      description: "Customer submits the order, then later customer submits the order.",
    });
    expect(ambiguous.blockers[0]).toMatchObject({ type: "quote_mismatch", sourceField: "description" });
    expect(ambiguous.knowledgeBase.modules[0].evidenceRefs?.[0].verification).toBe("unverified");

    const wrongField = verify(ref({ sourceField: "acceptanceCriteria" }), {
      description: "Customer submits the order",
      acceptanceCriteria: "",
    });
    expect(wrongField.blockers[0]).toMatchObject({ type: "source_field_missing" });
  });

  it("keeps legacy mismatches as warnings and never fabricates a snapshot", () => {
    const legacy = verify(ref({ origin: "migrated_legacy", quote: "Unsupported legacy phrase" }), {
      description: "Different source text",
    });
    expect(legacy.blockers).toEqual([]);
    expect(legacy.warnings[0]).toMatchObject({ type: "quote_mismatch" });

    const missing = verifyProjectKnowledgeEvidence({
      knowledgeBase: knowledge(ref({ origin: "migrated_legacy" })),
      snapshots: [],
    });
    expect(missing.warnings[0]).toMatchObject({ type: "snapshot_missing" });
  });

  it("rejects a snapshot that belongs to another work item", () => {
    const result = verifyProjectKnowledgeEvidence({
      knowledgeBase: knowledge(ref()),
      snapshots: [{
        id: "snapshot-1",
        sourceWorkItemId: "99",
        fields: { description: "Customer submits the order" },
      }],
    });
    expect(result.blockers[0]).toMatchObject({ type: "work_item_mismatch" });
  });
});
