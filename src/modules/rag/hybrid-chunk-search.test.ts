import { describe, expect, it } from "vitest";

import {
  applyDocumentDiversityCap,
  narrowSourceKindsForRetrieval,
  sourceDiversityCandidateLimit,
  sourceKindsNeedDocumentExistenceCheck,
  type FusedChunkResult,
} from "./hybrid-chunk-search";

function result(input: {
  id: string;
  sourceType: "azure_work_item" | "uploaded_document";
  sourceId: string;
  score?: number;
}): FusedChunkResult {
  return {
    score: input.score ?? 1,
    row: {
      id: input.id,
      source_type: input.sourceType,
      azure_work_item_id: input.sourceType === "azure_work_item" ? input.sourceId : null,
      work_item_type: input.sourceType === "azure_work_item" ? "User Story" : null,
      document_id: input.sourceType === "uploaded_document" ? input.sourceId : null,
      source_document_version_id: input.sourceType === "uploaded_document" ? `${input.sourceId}-v1` : null,
      document_name: input.sourceType === "uploaded_document" ? input.sourceId : "Story",
      section: null,
      page_number: null,
      content: input.id,
      metadata_json: null,
    },
  };
}

describe("document retrieval diversity", () => {
  it("widens mixed-source signal pools before applying the final top-K balance", () => {
    expect(sourceDiversityCandidateLimit(8, ["azure_work_item", "uploaded_document"])).toBe(24);
    expect(sourceDiversityCandidateLimit(8, ["azure_work_item"])).toBe(8);
    expect(sourceDiversityCandidateLimit(8, ["uploaded_document"])).toBe(8);
  });

  it("prefers at most roughly 40% document rows when work-item alternatives exist", () => {
    const ranked = [
      result({ id: "d1", sourceType: "uploaded_document", sourceId: "doc-1", score: 9 }),
      result({ id: "d2", sourceType: "uploaded_document", sourceId: "doc-2", score: 8 }),
      result({ id: "d3", sourceType: "uploaded_document", sourceId: "doc-3", score: 7 }),
      result({ id: "d4", sourceType: "uploaded_document", sourceId: "doc-4", score: 6 }),
      result({ id: "w1", sourceType: "azure_work_item", sourceId: "101", score: 5 }),
      result({ id: "w2", sourceType: "azure_work_item", sourceId: "102", score: 4 }),
      result({ id: "w3", sourceType: "azure_work_item", sourceId: "103", score: 3 }),
    ];

    const selected = applyDocumentDiversityCap(ranked, 5, ["azure_work_item", "uploaded_document"]);
    expect(selected.map((entry) => entry.row.id)).toEqual(["d1", "d2", "w1", "w2", "w3"]);
    expect(selected.filter((entry) => entry.row.source_type === "uploaded_document")).toHaveLength(2);
  });

  it("keeps document-only retrieval full rather than creating a sparse result", () => {
    const ranked = [
      result({ id: "d1", sourceType: "uploaded_document", sourceId: "doc-1" }),
      result({ id: "d2", sourceType: "uploaded_document", sourceId: "doc-2" }),
      result({ id: "d3", sourceType: "uploaded_document", sourceId: "doc-3" }),
    ];
    expect(applyDocumentDiversityCap(ranked, 3, ["azure_work_item", "uploaded_document"])).toEqual(ranked);
  });
});

describe("document existence gate", () => {
  it("never needs the EXISTS check when sourceKinds is pinned to azure_work_item", () => {
    expect(sourceKindsNeedDocumentExistenceCheck(["azure_work_item"])).toBe(false);
  });

  it("needs the EXISTS check whenever uploaded_document is in the effective sourceKinds", () => {
    expect(sourceKindsNeedDocumentExistenceCheck(["azure_work_item", "uploaded_document"])).toBe(true);
    expect(sourceKindsNeedDocumentExistenceCheck(["uploaded_document"])).toBe(true);
  });

  it("narrows to azure_work_item only when the project has no active documents", () => {
    expect(narrowSourceKindsForRetrieval(["azure_work_item", "uploaded_document"], false)).toEqual([
      "azure_work_item",
    ]);
  });

  it("stays wide when the project has active documents", () => {
    expect(narrowSourceKindsForRetrieval(["azure_work_item", "uploaded_document"], true)).toEqual([
      "azure_work_item",
      "uploaded_document",
    ]);
  });

  it("leaves an explicit azure_work_item-only request unchanged regardless of the (skipped) check's answer", () => {
    expect(narrowSourceKindsForRetrieval(["azure_work_item"], false)).toEqual(["azure_work_item"]);
    expect(narrowSourceKindsForRetrieval(["azure_work_item"], true)).toEqual(["azure_work_item"]);
  });
});
