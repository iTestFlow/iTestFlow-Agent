import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserWorkManagementProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  downloadWorkItemAttachment: vi.fn(),
  createStoryAttachment: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>()),
  requireWorkflowContext: mocks.requireWorkflowContext,
  getUserWorkManagementProvider: mocks.getUserWorkManagementProvider,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/story-attachments/story-attachments.service", () => ({
  createStoryAttachment: mocks.createStoryAttachment,
  StoryAttachmentValidationError: class StoryAttachmentValidationError extends Error {},
  StoryAttachmentNotReadyError: class StoryAttachmentNotReadyError extends Error {},
}));

import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

describe("story attachment import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1", providerId: "jira-cloud" } });
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.getUserWorkManagementProvider.mockResolvedValue({
      fetchWorkItemById: mocks.fetchWorkItemById,
      downloadWorkItemAttachment: mocks.downloadWorkItemAttachment,
    });
    mocks.fetchWorkItemById.mockResolvedValue({ id: "PAY-123", raw: { id: "10001" } });
    mocks.downloadWorkItemAttachment.mockResolvedValue({
      attachment: { id: "source-1", sourceWorkItemId: "10001", fileName: "design.pdf", contentType: "application/pdf", size: 8 },
      content: new TextEncoder().encode("pdf bytes").buffer,
    });
    mocks.createStoryAttachment.mockResolvedValue({
      attachment: { id: "story_attachment_1", originalFileName: "design.pdf", parseStatus: "pending", source: { kind: "jira_attachment" } },
      jobId: "job-1",
      reused: false,
    });
  });

  it("downloads only the verified provider attachment and saves it as an iTestFlow copy", async () => {
    const response = await POST(jsonRequest("/api/story-attachments/import", {
      scope: { ...projectScope(), workspaceId: "ws-1" },
      workItemId: "PAY-123",
      attachmentId: "source-1",
    }));

    expect(response.status).toBe(202);
    expect(mocks.downloadWorkItemAttachment).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      workItemId: "PAY-123",
      attachmentId: "source-1",
    });
    expect(mocks.createStoryAttachment).toHaveBeenCalledWith(expect.objectContaining({
      actor: "user-1",
      fileName: "design.pdf",
      declaredMimeType: "application/pdf",
      source: expect.objectContaining({ kind: "jira_attachment", externalAttachmentId: "source-1" }),
      scope: expect.objectContaining({ canonicalStoryId: "10001" }),
    }));
    expect(await response.json()).toMatchObject({ attachment: { id: "story_attachment_1" }, jobId: "job-1" });
  });

  it("does not persist a provider response whose owner is not the selected story", async () => {
    mocks.downloadWorkItemAttachment.mockResolvedValue({
      attachment: { id: "source-1", sourceWorkItemId: "other", fileName: "foreign.pdf" },
      content: new ArrayBuffer(0),
    });
    const response = await POST(jsonRequest("/api/story-attachments/import", {
      scope: { ...projectScope(), workspaceId: "ws-1" }, workItemId: "PAY-123", attachmentId: "source-1",
    }));

    expect(response.status).toBe(404);
    expect(mocks.createStoryAttachment).not.toHaveBeenCalled();
  });
});
