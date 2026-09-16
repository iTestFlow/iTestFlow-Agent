import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserWorkManagementProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  listStoryAttachments: vi.fn(),
  createStoryAttachment: vi.fn(),
  streamDocumentUploadMultipart: vi.fn(),
  removeStreamedDocumentMultipart: vi.fn(),
  readFile: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>()),
  requireWorkflowContext: mocks.requireWorkflowContext,
  getUserWorkManagementProvider: mocks.getUserWorkManagementProvider,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/story-attachments/story-attachments.service", () => ({
  listStoryAttachments: mocks.listStoryAttachments,
  createStoryAttachment: mocks.createStoryAttachment,
  StoryAttachmentValidationError: class StoryAttachmentValidationError extends Error {},
  StoryAttachmentNotReadyError: class StoryAttachmentNotReadyError extends Error {},
}));
vi.mock("@/modules/documents/streaming-multipart-upload", () => ({
  streamDocumentUploadMultipart: mocks.streamDocumentUploadMultipart,
  removeStreamedDocumentMultipart: mocks.removeStreamedDocumentMultipart,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: mocks.readFile,
}));
vi.mock("@/modules/auth/session.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/session.service")>()),
  requireSession: mocks.requireSession,
}));

import { projectScope } from "@/test/factories";
import { GET, POST } from "./route";

const scope = { ...projectScope(), workspaceId: "ws-1" };
const target = { id: "PAY-123", raw: { id: "10001" } };

function listRequest() {
  const url = new URL("http://localhost/api/story-attachments");
  url.searchParams.set("scope", JSON.stringify(scope));
  url.searchParams.set("workItemId", "PAY-123");
  return new Request(url);
}

describe("story attachment collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1", providerId: "jira-cloud" } });
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.getUserWorkManagementProvider.mockResolvedValue({ fetchWorkItemById: mocks.fetchWorkItemById });
    mocks.fetchWorkItemById.mockResolvedValue(target);
    mocks.listStoryAttachments.mockResolvedValue([{ id: "story_attachment_1", originalFileName: "design.pdf", parseStatus: "parsed", source: { kind: "upload" } }]);
    mocks.createStoryAttachment.mockResolvedValue({
      attachment: { id: "story_attachment_2", originalFileName: "mockup.png", parseStatus: "pending", source: { kind: "upload" } },
      jobId: "job-1",
      reused: false,
    });
    mocks.removeStreamedDocumentMultipart.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue(Buffer.from("mock upload"));
    mocks.requireSession.mockResolvedValue({ userId: "user-1" });
  });

  it("uses the provider's stable Jira issue id as the persisted story identity", async () => {
    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    expect(mocks.fetchWorkItemById).toHaveBeenCalledWith({ projectId: "azure-project-1", workItemId: "PAY-123" });
    expect(mocks.listStoryAttachments).toHaveBeenCalledWith({
      scope: {
        workspaceId: "ws-1",
        projectId: "project-1",
        providerId: "jira-cloud",
        canonicalStoryId: "10001",
        storyDisplayKey: "PAY-123",
      },
    });
    expect(await response.json()).toEqual({ attachments: [{ id: "story_attachment_1", originalFileName: "design.pdf", parseStatus: "parsed", sourceKind: "upload" }] });
  });

  it("streams an authenticated local upload into the story's private attachment service", async () => {
    mocks.streamDocumentUploadMultipart.mockResolvedValue({
      fields: { scope: JSON.stringify(scope), workItemId: "PAY-123" },
      files: [{ originalFileName: "mockup.png", mimeType: "image/png", tempPath: "C:/temp/mockup.upload", byteSize: 11 }],
      tempDirectory: "C:/temp/request",
    });
    const response = await POST(new Request("http://localhost/api/story-attachments", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(mocks.createStoryAttachment).toHaveBeenCalledWith(expect.objectContaining({
      actor: "user-1",
      fileName: "mockup.png",
      declaredMimeType: "image/png",
      source: { kind: "upload" },
      scope: expect.objectContaining({ canonicalStoryId: "10001", storyDisplayKey: "PAY-123" }),
    }));
    expect(mocks.removeStreamedDocumentMultipart).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ uploads: [{ attachment: { id: "story_attachment_2" }, jobId: "job-1" }] });
  });
});
