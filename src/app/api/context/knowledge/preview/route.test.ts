import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  previewGeneratedProjectKnowledgeBase: vi.fn(),
  writeGenerationFailureAudit: vi.fn(),
}));

// Keep the real authErrorResponse so auth failures short-circuit against real error
// classes while generation failures fall through to AppError/classifier mapping.
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
    getUserLLMProvider: mocks.getUserLLMProvider,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  previewGeneratedProjectKnowledgeBase: mocks.previewGeneratedProjectKnowledgeBase,
}));
vi.mock("@/modules/audit/generation-failure-audit", () => ({
  writeGenerationFailureAudit: mocks.writeGenerationFailureAudit,
}));

import {
  InvalidKnowledgeBaseOutputMessage,
  TruncatedKnowledgeBaseOutputMessage,
} from "@/modules/rag/knowledge-error-classification";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { fakeLlmProvider, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function previewRequest() {
  return jsonRequest("/api/context/knowledge/preview", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
  });
}

describe("POST /api/context/knowledge/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserLLMProvider.mockResolvedValue(fakeLlmProvider());
  });

  it("returns 400 for a non-JSON body before touching auth", async () => {
    const response = await POST(
      new Request("http://localhost/api/context/knowledge/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The request body must be valid JSON." });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  // Unlike the extract route, isAppError runs BEFORE the knowledge-output classifiers:
  // a truncation-shaped AppError gets its sanitized userMessage/code body at the
  // statusForServerError status, not the 422 truncation guidance.
  it("lets an AppError take precedence over truncation classification", async () => {
    mocks.previewGeneratedProjectKnowledgeBase.mockRejectedValue(
      new AppError({
        code: AppErrorCode.TokenLimit,
        message: "Output token budget exhausted.",
        userMessage: "The model ran out of output tokens.",
      }),
    );

    const response = await POST(previewRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "The model ran out of output tokens.",
      code: AppErrorCode.TokenLimit,
    });
    // The failure audit is written before the AppError branch returns.
    expect(mocks.writeGenerationFailureAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scope: trustedScope,
        actor: "user-1",
        action: "rag.preview_project_knowledge_base",
      }),
    );
  });

  it("maps a truncation failure to 422 with the truncation guidance", async () => {
    mocks.previewGeneratedProjectKnowledgeBase.mockRejectedValue(
      new Error("Response hit the max output token cap."),
    );

    const response = await POST(previewRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: TruncatedKnowledgeBaseOutputMessage });
  });

  it("maps invalid-output failures (SyntaxError) to 422 with the invalid-output guidance", async () => {
    mocks.previewGeneratedProjectKnowledgeBase.mockRejectedValue(
      new SyntaxError("Unexpected end of input"),
    );

    const response = await POST(previewRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: InvalidKnowledgeBaseOutputMessage });
  });

  it("normalizes unclassified provider errors before returning them", async () => {
    mocks.previewGeneratedProjectKnowledgeBase.mockRejectedValue(
      new Error("Azure DevOps rate limit exceeded."),
    );

    const response = await POST(previewRequest());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("The request could not be completed because a rate limit or quota was reached. Wait a moment, then try again.");
    expect(body.technicalDetails).toContain("Azure DevOps rate limit exceeded.");
  });
});
