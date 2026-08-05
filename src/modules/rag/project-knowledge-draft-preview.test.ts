import { describe, expect, it } from "vitest";

import {
  buildProjectKnowledgeDraftPreview,
  collectProjectKnowledgeDraftPreviewDocumentIds,
} from "./project-knowledge-draft-preview";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

const evidenceRef: ProjectKnowledgeEvidenceRef = {
  sourceSnapshotId: "snapshot-15",
  sourceWorkItemId: "15",
  sourceField: "acceptanceCriteria",
  quote: "Payment gateway is called.",
  origin: "generated_v4",
  verification: "exact",
};

const documentEvidenceRef: ProjectKnowledgeEvidenceRef = {
  sourceKind: "document",
  sourceDocumentId: "doc-1",
  sourceDocumentVersionId: "doc-1-v2",
  sourceField: "documentContent",
  quote: "The gateway is documented in the integration spec.",
  origin: "generated_v4",
  verification: "exact",
};

const knowledgeBase = ProjectKnowledgeBaseSchema.parse({
  modules: [{
    id: "checkout",
    name: "Checkout",
    description: "Completes purchases.",
    sourceWorkItemIds: ["15"],
    evidence: evidenceRef.quote,
    evidenceRefs: [evidenceRef],
  }],
  businessRules: [{
    id: "BR-1",
    rule: "Payment must succeed before an order is created.",
    sourceField: "acceptanceCriteria",
    moduleName: "Checkout",
    sourceWorkItemIds: ["15"],
    evidence: evidenceRef.quote,
    evidenceRefs: [evidenceRef],
  }],
  stateTransitions: [{
    id: "ST-1",
    workflowName: "Order",
    fromState: "Pending",
    toState: "Paid",
    triggerOrCondition: "Payment succeeds.",
    sourceWorkItemIds: ["15"],
    evidence: evidenceRef.quote,
    evidenceRefs: [evidenceRef],
  }],
  glossary: [{
    term: "Order",
    type: "business_entity",
    definition: "A completed purchase.",
    sourceWorkItemIds: ["15"],
    evidence: evidenceRef.quote,
    evidenceRefs: [evidenceRef],
  }],
  crossDependencies: [{
    id: "dep-checkout-gateway",
    sourceModule: "Checkout",
    targetModule: "Payment Gateway",
    dependencyType: "external service call",
    description: "Checkout calls the gateway.",
    sourceWorkItemIds: ["15"],
    evidence: evidenceRef.quote,
    evidenceRefs: [evidenceRef],
  }],
});

describe("buildProjectKnowledgeDraftPreview", () => {
  it("returns only one paginated slice with category counts and compact evidence", () => {
    const result = buildProjectKnowledgeDraftPreview({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      knowledgeBase,
      page: 2,
      pageSize: 2,
    });

    expect(result).toMatchObject({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      counts: {
        all: 5,
        module: 1,
        business_rule: 1,
        state_transition: 1,
        glossary: 1,
        dependency: 1,
      },
      page: 2,
      pageSize: 2,
      pageCount: 3,
      total: 5,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].evidence).toEqual([{
      sourceKind: "work_item",
      sourceWorkItemId: "15",
      sourceField: "acceptanceCriteria",
      quote: "Payment gateway is called.",
    }]);
    expect(JSON.stringify(result)).not.toContain("sourceSnapshotId");
  });

  it("filters by category and searches semantic fields and evidence", () => {
    const dependencyResult = buildProjectKnowledgeDraftPreview({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      knowledgeBase,
      category: "dependency",
      query: "PAYMENT GATEWAY",
    });
    expect(dependencyResult.total).toBe(1);
    expect(dependencyResult.entries[0]).toMatchObject({
      category: "dependency",
      title: "Checkout → Payment Gateway",
      fields: expect.arrayContaining([
        { id: "dependencyType", label: "Dependency type", value: "external service dependency" },
      ]),
    });

    expect(buildProjectKnowledgeDraftPreview({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      knowledgeBase,
      category: "module",
      query: "unrelated",
    })).toMatchObject({ total: 0, page: 1, pageCount: 1, entries: [] });
  });

  it("clamps page and page size to safe bounds", () => {
    expect(buildProjectKnowledgeDraftPreview({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      knowledgeBase,
      page: 99,
      pageSize: 500,
    })).toMatchObject({ page: 1, pageSize: 50, pageCount: 1 });
  });
});

describe("collectProjectKnowledgeDraftPreviewDocumentIds", () => {
  const knowledgeBaseWithDocumentEvidence = ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "checkout",
      name: "Checkout",
      description: "Completes purchases.",
      sourceWorkItemIds: [],
      evidence: documentEvidenceRef.quote,
      evidenceRefs: [documentEvidenceRef],
    }],
    businessRules: [{
      id: "BR-1",
      rule: "Payment must succeed before an order is created.",
      sourceField: "acceptanceCriteria",
      moduleName: "Checkout",
      sourceWorkItemIds: ["15"],
      evidence: evidenceRef.quote,
      evidenceRefs: [evidenceRef],
    }],
    stateTransitions: [],
    glossary: [{
      term: "Gateway",
      type: "system",
      definition: "The external payment gateway.",
      sourceWorkItemIds: [],
      evidence: documentEvidenceRef.quote,
      // Same document/version id as the module above, to verify dedup across entries.
      evidenceRefs: [documentEvidenceRef],
    }],
    crossDependencies: [],
  });

  it("collects the distinct document and version ids referenced by a page's evidence", () => {
    const preview = buildProjectKnowledgeDraftPreview({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      knowledgeBase: knowledgeBaseWithDocumentEvidence,
      pageSize: 50,
    });

    expect(collectProjectKnowledgeDraftPreviewDocumentIds(preview.entries)).toEqual({
      documentIds: ["doc-1"],
      versionIds: ["doc-1-v2"],
    });
  });

  it("returns empty arrays when a page only has work-item evidence", () => {
    const preview = buildProjectKnowledgeDraftPreview({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      knowledgeBase,
      pageSize: 50,
    });

    expect(collectProjectKnowledgeDraftPreviewDocumentIds(preview.entries)).toEqual({
      documentIds: [],
      versionIds: [],
    });
  });

  it("returns empty arrays for an empty entry list", () => {
    expect(collectProjectKnowledgeDraftPreviewDocumentIds([])).toEqual({
      documentIds: [],
      versionIds: [],
    });
  });
});
