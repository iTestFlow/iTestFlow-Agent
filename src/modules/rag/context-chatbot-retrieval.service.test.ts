import { describe, expect, it } from "vitest";

import { limitContextEvidenceByWorkItem } from "./context-chatbot-retrieval.service";

describe("limitContextEvidenceByWorkItem", () => {
  it("preserves relevance order while capping repeated chunks per work item", () => {
    const items = [
      { workItemId: "100", chunk: 1 },
      { workItemId: "100", chunk: 2 },
      { workItemId: "100", chunk: 3 },
      { workItemId: "200", chunk: 1 },
      { workItemId: "300", chunk: 1 },
      { workItemId: "200", chunk: 2 },
      { workItemId: "400", chunk: 1 },
    ];

    expect(limitContextEvidenceByWorkItem(items, { limit: 5, maxChunksPerWorkItem: 2 })).toEqual([
      { workItemId: "100", chunk: 1 },
      { workItemId: "100", chunk: 2 },
      { workItemId: "200", chunk: 1 },
      { workItemId: "300", chunk: 1 },
      { workItemId: "200", chunk: 2 },
    ]);
  });
});
