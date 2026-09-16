import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserWorkManagementProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  fetchWorkItemAttachments: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>()),
  requireWorkflowContext: mocks.requireWorkflowContext,
  getUserWorkManagementProvider: mocks.getUserWorkManagementProvider,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));

import { projectScope } from "@/test/factories";
import { GET } from "./route";

describe("story attachment source route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1", providerId: "jira-cloud" } });
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.getUserWorkManagementProvider.mockResolvedValue({
      fetchWorkItemById: mocks.fetchWorkItemById,
      fetchWorkItemAttachments: mocks.fetchWorkItemAttachments,
    });
    mocks.fetchWorkItemById.mockResolvedValue({ id: "PAY-123", raw: { id: "10001" } });
  });

  it("returns only source files whose provider owner matches the current stable story identity", async () => {
    mocks.fetchWorkItemAttachments.mockResolvedValue([
      { id: "a-1", sourceWorkItemId: "10001", fileName: "design.pdf", contentType: "application/pdf", size: 42 },
      { id: "a-2", sourceWorkItemId: "other-story", fileName: "foreign.pdf", contentType: "application/pdf" },
    ]);
    const scope = { ...projectScope(), workspaceId: "ws-1" };
    const url = new URL("http://localhost/api/story-attachments/source");
    url.searchParams.set("scope", JSON.stringify(scope));
    url.searchParams.set("workItemId", "PAY-123");

    const response = await GET(new Request(url));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attachments: [{ id: "a-1", fileName: "design.pdf", contentType: "application/pdf", size: 42 }],
    });
  });
});
