import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  assertNoActiveProjectKnowledgeBuild: vi.fn(),
  withProjectKnowledgeOperationGate: vi.fn((_scope, _operation, action) => action()),
}));
const drafts = vi.hoisted(() => ({
  applyProjectKnowledgeConflictDecisions: vi.fn(),
  publishProjectKnowledgeDraft: vi.fn(),
}));
const knowledge = vi.hoisted(() => ({ saveManualProjectKnowledgeBaseFromBatches: vi.fn() }));

vi.mock("@/modules/jobs/project-knowledge-operation-gate", () => gate);
vi.mock("./project-knowledge-draft.service", () => drafts);
vi.mock("./project-knowledge.service", () => knowledge);

import { projectScope } from "@/test/factories";
import {
  applyKnowledgeConflictDecisions,
  finalizeManualProjectKnowledge,
  publishReviewedProjectKnowledge,
} from "./project-knowledge-actions.service";

const scope = { ...projectScope(), workspaceId: "workspace-1" };
const readyDraft = {
  id: "draft-1",
  persistedStatus: "ready_to_publish",
  blockers: [],
  metrics: {},
  pendingDrift: false,
};

describe("synchronous project knowledge actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.assertNoActiveProjectKnowledgeBuild.mockResolvedValue(undefined);
    drafts.applyProjectKnowledgeConflictDecisions.mockResolvedValue(readyDraft);
    drafts.publishProjectKnowledgeDraft.mockResolvedValue({ ...readyDraft, persistedStatus: "published" });
    knowledge.saveManualProjectKnowledgeBaseFromBatches.mockResolvedValue(readyDraft);
  });

  it("finalizes validated external batches directly", async () => {
    await expect(finalizeManualProjectKnowledge({
      scope, actor: "owner-1", draftId: "draft-1", mode: "full",
    })).resolves.toMatchObject({ outcome: "ready_to_publish", draftId: "draft-1" });
    expect(knowledge.saveManualProjectKnowledgeBaseFromBatches).toHaveBeenCalledWith({
      scope, actor: "owner-1", draftId: "draft-1", mode: "full", partialKnowledgeBases: [],
    });
  });

  it("applies compact decisions directly under the operation gate", async () => {
    const decisions = [{ conflictId: "conflict-1", action: "keep" as const, participantId: "participant-1" }];
    await expect(applyKnowledgeConflictDecisions({
      scope, actor: "owner-1", draftId: "draft-1", draftVersion: "version-1", decisions,
    })).resolves.toMatchObject({ outcome: "ready_to_publish" });
    expect(gate.withProjectKnowledgeOperationGate).toHaveBeenCalledWith(scope, "apply_decisions", expect.any(Function));
    expect(drafts.applyProjectKnowledgeConflictDecisions).toHaveBeenCalledWith({
      scope, actor: "owner-1", draftId: "draft-1", draftVersion: "version-1", decisions,
    });
  });

  it("returns published, stale, and outdated outcomes without invoking a provider", async () => {
    drafts.publishProjectKnowledgeDraft.mockResolvedValueOnce({
      ...readyDraft, persistedStatus: "published", pendingDrift: true,
    });
    await expect(publishReviewedProjectKnowledge({ scope, actor: "owner-1", draftId: "draft-1" }))
      .resolves.toMatchObject({ outcome: "published", freshness: "stale" });

    drafts.publishProjectKnowledgeDraft.mockResolvedValueOnce({ ...readyDraft, persistedStatus: "superseded" });
    await expect(publishReviewedProjectKnowledge({ scope, actor: "owner-1", draftId: "draft-1" }))
      .resolves.toMatchObject({ outcome: "outdated" });
  });
});
