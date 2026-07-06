import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  promoteContextChatbotAnswer: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge-compiled.service", () => ({
  promoteContextChatbotAnswer: mocks.promoteContextChatbotAnswer,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = {
  scope: { ...trustedScope, workspaceId: "ws-1" },
  answer: "Checkout requires payment authorization.",
  citations: [{ sourceType: "project_context", sourceId: "chunk-1", workItemId: "42" }],
};

describe("POST /api/context/knowledge/promote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.promoteContextChatbotAnswer.mockResolvedValue({ promoted: true });
  });

  it("rejects malformed requests and empty citations", async () => {
    const malformed = await POST(new Request("http://localhost/api/context/knowledge/promote", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.status).toBe(400);
    const invalid = await POST(jsonRequest("/api/context/knowledge/promote", { ...body, citations: [] }));
    expect(invalid.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires an administrative role", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    const response = await POST(jsonRequest("/api/context/knowledge/promote", body));
    expect(response.status).toBe(403);
    expect(mocks.promoteContextChatbotAnswer).not.toHaveBeenCalled();
  });

  it("promotes only against the trusted project scope", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/promote", body));
    expect(response.status).toBe(200);
    expect(mocks.promoteContextChatbotAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ scope: trustedScope, answer: body.answer }),
    );
  });

  it("returns a stable validation failure for downstream rejection", async () => {
    mocks.promoteContextChatbotAnswer.mockRejectedValue(new Error("Citation is stale"));
    const response = await POST(jsonRequest("/api/context/knowledge/promote", body));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Citation is stale" });
  });
});
