import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  getSnapshot: vi.fn(),
  hasHealthyWorkerCapability: vi.fn(),
  getLatestInReviewDraft: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  getProjectKnowledgeBaseSnapshot: mocks.getSnapshot,
}));
vi.mock("@/modules/jobs/worker-registry.service", () => ({
  hasHealthyWorkerCapability: mocks.hasHealthyWorkerCapability,
}));
vi.mock("@/modules/jobs/project-knowledge-jobs.service", () => ({
  PROJECT_KNOWLEDGE_JOB: "project_knowledge_build",
}));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({
  getLatestInReviewProjectKnowledgeDraft: mocks.getLatestInReviewDraft,
}));

import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const scope = { ...projectScope(), workspaceId: "workspace-1" };

describe("project knowledge status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "member-1",
      workspace: { id: "workspace-1" },
      membership: { role: "member" },
    });
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.getSnapshot.mockResolvedValue({ id: "snapshot-1", status: "published" });
    mocks.hasHealthyWorkerCapability.mockResolvedValue(true);
    mocks.getLatestInReviewDraft.mockResolvedValue(null);
  });

  it("returns the snapshot together with generation availability", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/status", { scope }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      snapshot: { id: "snapshot-1", status: "published" },
      generationAvailable: true,
      latestInReviewDraft: null,
    });
    expect(mocks.hasHealthyWorkerCapability).toHaveBeenCalledWith("project_knowledge_build");
  });

  it("reports the latest in-review draft for resume", async () => {
    mocks.getLatestInReviewDraft.mockResolvedValue({
      id: "draft-7",
      status: "conflicts_required",
      updatedAt: "2026-07-18T09:00:00.000Z",
      conflictCount: 3,
    });
    const response = await POST(jsonRequest("/api/context/knowledge/status", { scope }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      latestInReviewDraft: {
        id: "draft-7",
        status: "conflicts_required",
        conflictCount: 3,
      },
    });
    expect(mocks.getLatestInReviewDraft).toHaveBeenCalledWith({ scope: projectScope() });
  });

  it("reports generation as unavailable when no capable worker is healthy", async () => {
    mocks.hasHealthyWorkerCapability.mockResolvedValue(false);
    const response = await POST(jsonRequest("/api/context/knowledge/status", { scope }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ generationAvailable: false });
  });
});
