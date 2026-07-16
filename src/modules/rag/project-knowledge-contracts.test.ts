import { describe, expect, it } from "vitest";

import {
  PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
  PROJECT_KNOWLEDGE_DRAFT_HEARTBEAT_TTL_MS,
  PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION,
  PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION,
  PROJECT_KNOWLEDGE_WORDING_VERSION,
  canonicalJson,
  canonicalizeBusinessRuleSourceFieldForProjection,
  canonicalizeProjectKnowledgeLogicalIdentity,
  computeProjectKnowledgeHashes,
  computeProjectKnowledgeSourceFingerprint,
  displayProjectKnowledgeDraftStatus,
  flattenProjectKnowledgeSemanticEntries,
  getEntryProvenanceStatus,
} from "./project-knowledge-contracts";
import {
  ProjectKnowledgeBaseSchema,
  renderProjectKnowledgeEvidenceRefs,
  splitProjectKnowledgeLegacyEvidence,
  splitProjectKnowledgeRenderedEvidence,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";

const ref = (overrides: Partial<ProjectKnowledgeEvidenceRef> = {}): ProjectKnowledgeEvidenceRef => ({
  sourceSnapshotId: "snapshot-1",
  sourceWorkItemId: "1",
  sourceField: "description",
  quote: "Checkout requires payment",
  origin: "generated_v2",
  verification: "exact",
  ...overrides,
});

function baseKnowledge() {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "mod-checkout",
      name: "Checkout",
      description: "Handles checkout.",
      sourceWorkItemIds: ["1"],
      evidence: "Checkout requires payment",
      evidenceRefs: [ref()],
    }],
    businessRules: [{
      id: "br-payment",
      rule: "Checkout requires payment.",
      sourceField: "acceptanceCriteria",
      moduleName: "Checkout",
      sourceWorkItemIds: ["1"],
      evidence: "Checkout requires payment",
      evidenceRefs: [ref({ sourceField: "acceptanceCriteria" })],
    }],
    stateTransitions: [{
      id: "st-order",
      workflowName: "Order",
      fromState: "Draft",
      toState: "Submitted",
      triggerOrCondition: "Customer submits the order",
      actor: "Customer",
      moduleName: "Checkout",
      sourceWorkItemIds: ["1"],
      evidence: "Customer submits the order",
      evidenceRefs: [ref({ quote: "Customer submits the order" })],
    }],
    glossary: [{
      term: "Order",
      type: "business_entity",
      definition: "A submitted purchase.",
      sourceWorkItemIds: ["1"],
      evidence: "submitted purchase",
      evidenceRefs: [ref({ quote: "submitted purchase" })],
    }],
    crossDependencies: [{
      id: "dep-checkout-payments",
      sourceModule: "Checkout",
      targetModule: "Payments",
      dependencyType: "requires",
      description: "Checkout invokes Payments.",
      sourceWorkItemIds: ["1"],
      evidence: "Checkout invokes Payments",
      evidenceRefs: [ref({ quote: "Checkout invokes Payments" })],
    }],
  });
}

describe("project knowledge canonical hashes", () => {
  it("creates category-specific projections for all five semantic categories", () => {
    const entries = flattenProjectKnowledgeSemanticEntries(baseKnowledge());
    expect(entries.map((entry) => entry.category)).toEqual([
      "business_rule",
      "dependency",
      "glossary",
      "module",
      "state_transition",
    ]);
    expect(entries.find((entry) => entry.category === "business_rule")?.projection).toEqual({
      rule: "Checkout requires payment.",
      sourceField: "acceptanceCriteria",
      moduleName: "Checkout",
    });
    expect(entries.find((entry) => entry.category === "business_rule")?.entry).toMatchObject({
      id: "br-payment",
      rule: "Checkout requires payment.",
    });
  });

  it("uses compiler contract v4.1 without changing the hash algorithm versions", () => {
    expect(PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION).toBe("4.1.0");
    expect(PROJECT_KNOWLEDGE_WORDING_VERSION).toBe("4.0.0");
    expect(PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION).toBe("semantic-v2");
    expect(PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION).toBe("provenance-v2");
  });

  it("keeps evidence and sources out of semantic hashes while changing provenance hashes", () => {
    const first = baseKnowledge();
    const second = ProjectKnowledgeBaseSchema.parse({
      ...first,
      modules: [{
        ...first.modules[0],
        sourceWorkItemIds: ["2"],
        evidence: "Different evidence",
        evidenceRefs: [ref({ sourceSnapshotId: "snapshot-2", sourceWorkItemId: "2", quote: "Different evidence" })],
      }],
    });
    const firstHashes = computeProjectKnowledgeHashes(first);
    const secondHashes = computeProjectKnowledgeHashes(second);
    expect(secondHashes.semanticKnowledgeHash).toBe(firstHashes.semanticKnowledgeHash);
    expect(secondHashes.provenanceHash).not.toBe(firstHashes.provenanceHash);
    expect(secondHashes.entries.find((entry) => entry.category === "module")?.entrySemanticHash)
      .toBe(firstHashes.entries.find((entry) => entry.category === "module")?.entrySemanticHash);
  });

  it("keeps hashes stable when business-rule constraints and module associations differ", () => {
    const first = baseKnowledge();
    const second = ProjectKnowledgeBaseSchema.parse({
      ...first,
      businessRules: [{
        ...first.businessRules[0],
        moduleAssociations: ["Checkout", "Payments"],
        constraint: {
          object: "checkout",
          property: "payment",
          operator: "eq",
          value: "required",
          valueType: "boolean",
        },
      }],
    });

    expect(second.businessRules[0]).toMatchObject({
      moduleAssociations: ["Checkout", "Payments"],
      constraint: {
        object: "checkout",
        property: "payment",
        operator: "eq",
        value: "true",
        valueType: "boolean",
      },
    });

    const firstHashes = computeProjectKnowledgeHashes(first);
    const secondHashes = computeProjectKnowledgeHashes(second);
    expect(secondHashes.semanticKnowledgeHash).toBe(firstHashes.semanticKnowledgeHash);
    expect(secondHashes.provenanceHash).toBe(firstHashes.provenanceHash);
    expect(secondHashes.entries.find((entry) => entry.category === "business_rule")?.entrySemanticHash)
      .toBe(firstHashes.entries.find((entry) => entry.category === "business_rule")?.entrySemanticHash);
    expect(secondHashes.entries.find((entry) => entry.category === "business_rule")?.entryProvenanceHash)
      .toBe(firstHashes.entries.find((entry) => entry.category === "business_rule")?.entryProvenanceHash);
  });

  it("treats evidence-derived default descriptions as semantic", () => {
    const parse = (evidence: string) => ProjectKnowledgeBaseSchema.parse({
      modules: [{ id: "mod-a", name: "A", description: "", sourceWorkItemIds: ["1"], evidence }],
    });
    expect(computeProjectKnowledgeHashes(parse("First supported description")).semanticKnowledgeHash)
      .not.toBe(computeProjectKnowledgeHashes(parse("Second supported description")).semanticKnowledgeHash);
  });

  it("treats normalized dependency endpoint notes as semantic", () => {
    const direct = ProjectKnowledgeBaseSchema.parse({
      modules: [{ id: "mod-checkout", name: "Checkout", description: "Area", sourceWorkItemIds: ["1"], evidence: "Area" }],
      crossDependencies: [{
        id: "dep-1",
        sourceModule: "Checkout",
        targetModule: "External API",
        dependencyType: "calls",
        description: "Calls API",
        sourceWorkItemIds: ["1"],
        evidence: "Calls API",
      }],
    });
    const normalized = ProjectKnowledgeBaseSchema.parse({
      ...direct,
      crossDependencies: [{ ...direct.crossDependencies[0], sourceModule: "Checkout Step 2" }],
    });
    expect(normalized.crossDependencies[0].description).toContain("Original source endpoint");
    expect(computeProjectKnowledgeHashes(normalized).semanticKnowledgeHash)
      .not.toBe(computeProjectKnowledgeHashes(direct).semanticKnowledgeHash);
  });

  it("canonicalizes legacy business-rule source fields for hashing only", () => {
    const first = baseKnowledge();
    const second = ProjectKnowledgeBaseSchema.parse({
      ...first,
      businessRules: [{ ...first.businessRules[0], sourceField: "Acceptance Criteria" }],
    });
    expect(second.businessRules[0].sourceField).toBe("Acceptance Criteria");
    expect(canonicalizeBusinessRuleSourceFieldForProjection("Acceptance Criteria")).toBe("acceptanceCriteria");
    expect(computeProjectKnowledgeHashes(second).semanticKnowledgeHash)
      .toBe(computeProjectKnowledgeHashes(first).semanticKnowledgeHash);
  });

  it("sorts nested object keys recursively", () => {
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }] }))
      .toBe('{"a":[{"x":1,"y":2}],"z":{"a":1,"b":2}}');
  });

  it("orders equivalent EvidenceRef locators independently of nested key insertion order", () => {
    const first = ref({ quote: "First", locator: { section: { z: 1, a: 2 } } });
    const second = ref({ quote: "Second", locator: { section: { a: 2, z: 1 } } });
    expect(renderProjectKnowledgeEvidenceRefs([second, first])).toBe("First | Second");
  });

  it("round-trips compatibility evidence containing pipes and backslashes", () => {
    const rendered = renderProjectKnowledgeEvidenceRefs([
      ref({ quote: "First | quoted \\ path", sourceWorkItemId: "1" }),
      ref({ quote: "Second", sourceWorkItemId: "2" }),
    ]);

    expect(rendered).toContain("\\|");
    expect(splitProjectKnowledgeRenderedEvidence(rendered)).toEqual([
      "First | quoted \\ path",
      "Second",
    ]);
  });

  it("never unescapes backslashes in legacy compatibility evidence", () => {
    const legacy = String.raw`\\server\share\file.txt | regex \d+\|\w+`;
    expect(splitProjectKnowledgeLegacyEvidence(legacy)).toEqual([
      String.raw`\\server\share\file.txt`,
      String.raw`regex \d+\|\w+`,
    ]);
  });

  it("distinguishes unknown, unverified, partial, and fully verified provenance", () => {
    expect(getEntryProvenanceStatus([])).toBe("legacy_unknown");
    expect(getEntryProvenanceStatus([ref({ verification: "unverified" })])).toBe("legacy_unverified");
    expect(getEntryProvenanceStatus([
      ref({ sourceSnapshotId: "snapshot-1", verification: "normalized" }),
      ref({ sourceSnapshotId: "snapshot-2", verification: "unverified" }),
    ])).toBe("partial");
    expect(getEntryProvenanceStatus([
      ref({ sourceSnapshotId: "snapshot-1", verification: "exact" }),
      ref({ sourceSnapshotId: "snapshot-2", verification: "auto_reanchored" }),
    ])).toBe("verified");
  });
});

describe("source and lifecycle contracts", () => {
  it("normalizes separator aliases only for logical identity matching", () => {
    expect(canonicalizeProjectKnowledgeLogicalIdentity(" MOD_AUTH ")).toBe("mod-auth");
    expect(canonicalizeProjectKnowledgeLogicalIdentity("mod auth")).toBe("mod-auth");
    expect(canonicalizeProjectKnowledgeLogicalIdentity("mod-auth")).toBe("mod-auth");
    expect(canonicalizeProjectKnowledgeLogicalIdentity("C++")).toBe("c++");
    expect(canonicalizeProjectKnowledgeLogicalIdentity("C#")).toBe("c#");
    expect(canonicalizeProjectKnowledgeLogicalIdentity("Διαδρομή Πελάτη")).toBe("διαδρομή-πελάτη");
    expect(canonicalizeProjectKnowledgeLogicalIdentity("客户 流程")).toBe("客户-流程");
  });

  it("fingerprints a complete source manifest independently of input order", () => {
    const manifest = [
      { sourceSnapshotId: "s2", sourceWorkItemId: "2", workItemType: "Story", contentHash: "h2", adoRevision: 2, capturedAt: "2026-01-02" },
      { sourceSnapshotId: "s1", sourceWorkItemId: "1", workItemType: "Story", contentHash: "h1", adoRevision: 1, capturedAt: "2026-01-01" },
    ];
    expect(computeProjectKnowledgeSourceFingerprint(manifest))
      .toBe(computeProjectKnowledgeSourceFingerprint([...manifest].reverse()));
    expect(computeProjectKnowledgeSourceFingerprint(manifest))
      .not.toBe(computeProjectKnowledgeSourceFingerprint([{ ...manifest[0], contentHash: "changed" }, manifest[1]]));
  });

  it("reports compiling only while the generating heartbeat is fresh", () => {
    const now = Date.parse("2026-01-01T00:20:00.000Z");
    expect(displayProjectKnowledgeDraftStatus("generating", new Date(now - 1000).toISOString(), now)).toBe("compiling");
    expect(displayProjectKnowledgeDraftStatus(
      "generating",
      new Date(now - PROJECT_KNOWLEDGE_DRAFT_HEARTBEAT_TTL_MS - 1).toISOString(),
      now,
    )).toBe("generating");
    expect(displayProjectKnowledgeDraftStatus("ready_for_review", new Date(now).toISOString(), now)).toBe("ready_for_review");
  });

  it("derives compatibility evidence with the exact pipe round trip", () => {
    const parsed = ProjectKnowledgeBaseSchema.parse({
      modules: [{
        id: "mod-a",
        name: "A",
        description: "Area",
        sourceWorkItemIds: ["legacy"],
        evidence: "legacy",
        evidenceRefs: [
          ref({ sourceSnapshotId: "s2", sourceWorkItemId: "2", quote: "Second quote" }),
          ref({ sourceSnapshotId: "s1", sourceWorkItemId: "1", quote: "First quote" }),
        ],
      }],
    });
    expect(parsed.modules[0].sourceWorkItemIds).toEqual(["1", "2"]);
    expect(parsed.modules[0].evidence).toBe("First quote | Second quote");
    expect(parsed.modules[0].evidence.split(" | ").join(" | ")).toBe(parsed.modules[0].evidence);
  });
});
