import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(), resolveProjectScope: vi.fn(), getConflicts: vi.fn(),
}));
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({ getProjectKnowledgeDraftConflicts: mocks.getConflicts }));

import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const scope = projectScope();
const body = { scope: { ...scope, workspaceId: "workspace-1" }, page: 2, pageSize: 50 };
const params = { params: Promise.resolve({ draftId: "draft-1" }) };

describe("POST compact draft conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "member-1", workspace: { id: "workspace-1" } });
    mocks.resolveProjectScope.mockResolvedValue(scope);
    mocks.getConflicts.mockResolvedValue({ draftVersion: "opaque", page: 2, pageSize: 50, total: 75, conflicts: [] });
  });

  it("rejects malformed scope and more than 50 cards", async () => {
    const malformedJson = await POST(new Request("http://localhost/conflicts", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }), params);
    expect(malformedJson.status).toBe(400);
    expect((await POST(jsonRequest("/conflicts", { scope: null }), params)).status).toBe(400);
    expect((await POST(jsonRequest("/conflicts", { ...body, pageSize: 51 }), params)).status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("loads only one compact server page under trusted scope", async () => {
    const response = await POST(jsonRequest("/conflicts", body), params);
    expect(response.status).toBe(200);
    expect(mocks.getConflicts).toHaveBeenCalledWith({ scope, draftId: "draft-1", page: 2, pageSize: 50 });
    expect(await response.json()).toEqual({ draftVersion: "opaque", page: 2, pageSize: 50, total: 75, conflicts: [] });
  });

  it("returns a stable server error when compact conflict loading fails", async () => {
    mocks.getConflicts.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(jsonRequest("/conflicts", body), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "The service is temporarily unavailable. Try again in a moment." });
  });
});
