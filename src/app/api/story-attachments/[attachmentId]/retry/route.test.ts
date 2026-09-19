import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserWorkManagementProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  retryStoryAttachment: vi.fn(),
  StoryAttachmentValidationError: class StoryAttachmentValidationError extends Error {},
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>()),
  requireWorkflowContext: mocks.requireWorkflowContext,
  getUserWorkManagementProvider: mocks.getUserWorkManagementProvider,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/story-attachments/story-attachments.service", () => ({
  retryStoryAttachment: mocks.retryStoryAttachment,
  StoryAttachmentValidationError: mocks.StoryAttachmentValidationError,
  StoryAttachmentNotReadyError: class StoryAttachmentNotReadyError extends Error {},
}));

import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

describe("story attachment retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1", providerId: "azure-devops" } });
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.getUserWorkManagementProvider.mockResolvedValue({ fetchWorkItemById: mocks.fetchWorkItemById });
    mocks.fetchWorkItemById.mockResolvedValue({ id: "123", raw: { id: 123 } });
    mocks.retryStoryAttachment.mockResolvedValue({
      attachment: { id: "story_attachment_1", originalFileName: "design.pdf", parseStatus: "pending", source: { kind: "upload" } },
      jobId: "job-2",
    });
  });

  it("requeues only a saved attachment scoped to the accessible story", async () => {
    const response = await POST(jsonRequest("/api/story-attachments/story_attachment_1/retry", {
      scope: { ...projectScope(), workspaceId: "ws-1" }, workItemId: "123",
    }), { params: Promise.resolve({ attachmentId: "story_attachment_1" }) });

    expect(response.status).toBe(202);
    expect(mocks.retryStoryAttachment).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: "story_attachment_1", actor: "user-1", scope: expect.objectContaining({ canonicalStoryId: "123" }),
    }));
    expect(await response.json()).toMatchObject({ attachment: { id: "story_attachment_1" }, jobId: "job-2" });
  });

  it("returns a safe validation error when the attachment is not failed", async () => {
    mocks.retryStoryAttachment.mockRejectedValue(new mocks.StoryAttachmentValidationError("Only attachments whose processing failed can be retried."));

    const response = await POST(jsonRequest("/api/story-attachments/story_attachment_1/retry", {
      scope: { ...projectScope(), workspaceId: "ws-1" }, workItemId: "123",
    }), { params: Promise.resolve({ attachmentId: "story_attachment_1" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Only attachments whose processing failed can be retried." });
  });
});
