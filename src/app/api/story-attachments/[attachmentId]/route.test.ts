import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserWorkManagementProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  getStoryAttachment: vi.fn(),
  deleteStoryAttachment: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>()),
  requireWorkflowContext: mocks.requireWorkflowContext,
  getUserWorkManagementProvider: mocks.getUserWorkManagementProvider,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/workspace/workspace-access.service", () => ({ getWorkspaceMembership: mocks.getWorkspaceMembership }));
vi.mock("@/modules/story-attachments/story-attachments.service", () => ({
  getStoryAttachment: mocks.getStoryAttachment,
  deleteStoryAttachment: mocks.deleteStoryAttachment,
  StoryAttachmentValidationError: class StoryAttachmentValidationError extends Error {},
  StoryAttachmentNotReadyError: class StoryAttachmentNotReadyError extends Error {},
}));

import { jsonRequest, projectScope } from "@/test/factories";
import { DELETE } from "./route";

const params = { params: Promise.resolve({ attachmentId: "story_attachment_1" }) };

describe("story attachment item deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "uploader", workspace: { id: "ws-1", providerId: "azure-devops" } });
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.getUserWorkManagementProvider.mockResolvedValue({ fetchWorkItemById: mocks.fetchWorkItemById });
    mocks.fetchWorkItemById.mockResolvedValue({ id: "123", raw: { id: 123 } });
    mocks.getStoryAttachment.mockResolvedValue({ id: "story_attachment_1", createdBy: "uploader", source: { kind: "upload" }, originalFileName: "design.pdf", parseStatus: "parsed" });
    mocks.deleteStoryAttachment.mockResolvedValue({ id: "story_attachment_1", source: { kind: "upload" }, originalFileName: "design.pdf", parseStatus: "parsed" });
  });

  it("allows the uploader to tombstone only the saved iTestFlow copy", async () => {
    const response = await DELETE(jsonRequest("/api/story-attachments/story_attachment_1", {
      scope: { ...projectScope(), workspaceId: "ws-1" }, workItemId: "123",
    }, { method: "DELETE" }), params);

    expect(response.status).toBe(200);
    expect(mocks.deleteStoryAttachment).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: "story_attachment_1",
      actor: "uploader",
      scope: expect.objectContaining({ canonicalStoryId: "123" }),
    }));
    expect(await response.json()).toMatchObject({ attachment: { id: "story_attachment_1" } });
  });

  it("denies a different member unless they are an owner or admin", async () => {
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "member", workspace: { id: "ws-1", providerId: "azure-devops" } });
    mocks.getStoryAttachment.mockResolvedValue({ id: "story_attachment_1", createdBy: "uploader", source: { kind: "upload" } });
    mocks.getWorkspaceMembership.mockResolvedValue({ role: "member" });
    const response = await DELETE(jsonRequest("/api/story-attachments/story_attachment_1", {
      scope: { ...projectScope(), workspaceId: "ws-1" }, workItemId: "123",
    }, { method: "DELETE" }), params);

    expect(response.status).toBe(403);
    expect(mocks.deleteStoryAttachment).not.toHaveBeenCalled();
  });
});
