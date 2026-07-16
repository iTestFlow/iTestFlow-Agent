import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  getPreview: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({
  getProjectKnowledgeDraftPreview: mocks.getPreview,
}));

import { jsonRequest, projectScope } from "@/test/factories";
import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { POST } from "./route";

const trustedScope = projectScope();
const scope = { ...trustedScope, workspaceId: "workspace-1" };
const params = { params: Promise.resolve({ draftId: "draft-1" }) };

describe("POST paginated draft preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "member-1",
      workspace: { id: "workspace-1" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getPreview.mockResolvedValue({
      draftId: "draft-1",
      draftVersion: "version-1",
      status: "ready_to_publish",
      counts: { all: 1, dependency: 1 },
      page: 1,
      pageSize: 10,
      pageCount: 1,
      total: 1,
      entries: [],
    });
  });

  it("rejects malformed and oversized requests before authentication", async () => {
    const malformedJson = await POST(new Request("http://localhost/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), params);
    expect(malformedJson.status).toBe(400);
    expect((await POST(jsonRequest("/preview", { scope: null }), params)).status).toBe(400);
    expect((await POST(jsonRequest("/preview", { scope, pageSize: 51 }), params)).status).toBe(400);
    expect((await POST(jsonRequest("/preview", { scope, category: "unknown" }), params)).status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("returns the authentication response without loading preview data", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new WorkflowAuthError("Sign in required.", 401));

    const response = await POST(jsonRequest("/preview", { scope }), params);

    expect(response.status).toBe(401);
    expect(mocks.getPreview).not.toHaveBeenCalled();
  });

  it("loads one compact preview page under trusted scope", async () => {
    const response = await POST(jsonRequest("/preview", {
      scope,
      category: "dependency",
      query: "gateway",
      page: 2,
      pageSize: 10,
    }), params);

    expect(response.status).toBe(200);
    expect(mocks.getPreview).toHaveBeenCalledWith({
      scope: trustedScope,
      draftId: "draft-1",
      category: "dependency",
      query: "gateway",
      page: 2,
      pageSize: 10,
    });
  });

  it("returns a stable error when preview loading fails", async () => {
    mocks.getPreview.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(jsonRequest("/preview", { scope }), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "The service is temporarily unavailable. Try again in a moment.",
    });
  });
});
