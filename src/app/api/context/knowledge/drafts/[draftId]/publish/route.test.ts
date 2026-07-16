import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge-actions.service", () => ({ publishReviewedProjectKnowledge: mocks.publish }));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const scope = projectScope();
const body = { scope: { ...scope, workspaceId: "workspace-1" } };
const params = { params: Promise.resolve({ draftId: "draft-1" }) };

describe("POST reviewed project knowledge publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(scope);
    mocks.publish.mockResolvedValue({ outcome: "published", draftId: "draft-1", freshness: "current" });
  });

  it("rejects malformed requests before authentication", async () => {
    const response = await POST(new Request("http://localhost/publish", {
      method: "POST", body: "{", headers: { "content-type": "application/json" },
    }), params);
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owner or admin", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    expect((await POST(jsonRequest("/publish", body), params)).status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("returns published and outdated outcomes directly", async () => {
    const published = await POST(jsonRequest("/publish", body), params);
    expect(published.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith({ scope, actor: "owner-1", draftId: "draft-1" });

    mocks.publish.mockResolvedValue({ outcome: "outdated", draftId: "draft-1" });
    const outdated = await POST(jsonRequest("/publish", body), params);
    expect(outdated.status).toBe(200);
    expect(await outdated.json()).toMatchObject({ outcome: "outdated" });
  });
});
