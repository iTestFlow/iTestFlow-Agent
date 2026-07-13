import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  validateProjectKnowledgeManualBatch: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  validateProjectKnowledgeManualBatch: mocks.validateProjectKnowledgeManualBatch,
}));

import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function validateRequest(rawOutput = "{\"knowledgeBase\":{}}") {
  return jsonRequest("/api/context/knowledge/manual/validate", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    rawOutput,
    draftId: "draft-1",
    batchIndex: 1,
  });
}

describe("POST /api/context/knowledge/manual/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.validateProjectKnowledgeManualBatch.mockResolvedValue({ sections: [] });
  });

  it("returns 422, not 503, when external output is invalid JSON", async () => {
    mocks.validateProjectKnowledgeManualBatch.mockImplementation(() => {
      throw new AppError({
        code: AppErrorCode.InvalidJson,
        message: "External LLM output was not valid JSON.",
        userMessage: "The external LLM response was not valid JSON.",
      });
    });

    const response = await POST(validateRequest("not json"));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "The external LLM response was not valid JSON.",
      code: AppErrorCode.InvalidJson,
    });
  });
});
