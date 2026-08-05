import { describe, expect, it } from "vitest";

import {
  computeProjectKnowledgeHashes,
  getEntryProvenanceStatus,
} from "./project-knowledge-contracts";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

/**
 * Regression for the M2 (document-evidence) rollout: an all-Azure-DevOps knowledge
 * base must compile to the exact same semantic/provenance hashes it did before
 * document evidence existed. If this test starts failing, every already-published
 * entry_provenance_hash and project_knowledge_base.provenance_hash in production
 * would go stale on the next build (spurious "knowledge_change" log rows and lost
 * confirm short-circuits) unless the reshaping is a deliberate compiler-contract
 * version bump.
 */

const workItemRef = (overrides: Partial<ProjectKnowledgeEvidenceRef> = {}): ProjectKnowledgeEvidenceRef => ({
  sourceSnapshotId: "snapshot-1",
  sourceWorkItemId: "1",
  sourceField: "description",
  quote: "Checkout requires payment",
  origin: "generated_v2",
  verification: "exact",
  ...overrides,
});

function adoOnlyKnowledgeBase() {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "mod-checkout",
      name: "Checkout",
      description: "Handles checkout.",
      sourceWorkItemIds: ["1"],
      evidence: "Checkout requires payment",
      evidenceRefs: [workItemRef()],
    }],
    businessRules: [{
      id: "br-payment",
      rule: "Checkout requires payment.",
      sourceField: "acceptanceCriteria",
      moduleName: "Checkout",
      sourceWorkItemIds: ["1"],
      evidence: "Checkout requires payment",
      evidenceRefs: [workItemRef({ sourceField: "acceptanceCriteria" })],
    }],
    stateTransitions: [{
      id: "st-order",
      workflowName: "Order",
      fromState: "Draft",
      toState: "Submitted",
      triggerOrCondition: "Customer submits the order",
      actor: "Customer",
      moduleName: "Checkout",
      sourceWorkItemIds: ["2"],
      evidence: "Customer submits the order",
      evidenceRefs: [workItemRef({
        sourceSnapshotId: "snapshot-2",
        sourceWorkItemId: "2",
        quote: "Customer submits the order",
        verification: "auto_reanchored",
      })],
    }],
    glossary: [{
      term: "Order",
      type: "business_entity",
      definition: "A submitted purchase.",
      sourceWorkItemIds: ["2"],
      evidence: "submitted purchase",
      evidenceRefs: [workItemRef({
        sourceSnapshotId: "snapshot-2",
        sourceWorkItemId: "2",
        quote: "submitted purchase",
        verification: "normalized",
      })],
    }],
    crossDependencies: [{
      id: "dep-checkout-payments",
      sourceModule: "Checkout",
      targetModule: "Payments",
      dependencyType: "requires",
      description: "Checkout invokes Payments.",
      sourceWorkItemIds: ["1"],
      evidence: "Checkout invokes Payments",
      evidenceRefs: [workItemRef({ quote: "Checkout invokes Payments" })],
    }],
  });
}

describe("ADO-only knowledge build stability", () => {
  it("compiles a frozen work-item-only knowledge base to the pinned v-HEAD hashes", () => {
    const knowledgeBase = adoOnlyKnowledgeBase();
    const hashes = computeProjectKnowledgeHashes(knowledgeBase);

    // Frozen v-HEAD (pre-M2 / compiler contract 4.2.0) values for the fixture
    // above. Changing these requires a deliberate compiler-contract decision,
    // not an incidental refactor of the hashing projections.
    expect(hashes.semanticKnowledgeHash).toBe("6831b62067725e2c01c13beaf30deb914a8ddb665665ed2e7d2257c2ff7e599b");
    expect(hashes.provenanceHash).toBe("127444e715203f7a98c084d00ebbba1065336a89a43ef714d0d59c73e6501a2d");
  });

  it("keeps provenance status verified and the confirm-path hash precondition stable across a recompute", () => {
    const knowledgeBase = adoOnlyKnowledgeBase();
    const first = computeProjectKnowledgeHashes(knowledgeBase);
    const second = computeProjectKnowledgeHashes(adoOnlyKnowledgeBase());

    for (const entry of first.entries) {
      expect(getEntryProvenanceStatus(entry.evidenceRefs)).toBe("verified");
    }

    // Mirrors the confirm-path precondition in project-knowledge-compiled.service.ts:
    // an unchanged entry must recompute to the same semantic + provenance hash so
    // the compiler takes the confirm short-circuit instead of writing a spurious
    // new entry_versions row.
    expect(second.semanticKnowledgeHash).toBe(first.semanticKnowledgeHash);
    expect(second.provenanceHash).toBe(first.provenanceHash);
    for (const entry of second.entries) {
      const previous = first.entries.find(
        (candidate) => candidate.category === entry.category && candidate.entryKey === entry.entryKey,
      );
      expect(previous?.entrySemanticHash).toBe(entry.entrySemanticHash);
      expect(previous?.entryProvenanceHash).toBe(entry.entryProvenanceHash);
    }
  });
});
