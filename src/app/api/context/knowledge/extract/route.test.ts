import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  extractAndSaveProjectKnowledgeBase: vi.fn(),
  writeGenerationFailureAudit: vi.fn(),
}));

// Keep the real authErrorResponse (and WorkflowAuthError) so the route's auth
// short-circuit in the catch block is exercised against real error classes.
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
  extractAndSaveProjectKnowledgeBase: mocks.extractAndSaveProjectKnowledgeBase,
}));
vi.mock("@/modules/audit/generation-failure-audit", () => ({
  writeGenerationFailureAudit: mocks.writeGenerationFailureAudit,
}));

import { z } from "zod";
import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import {
  InvalidKnowledgeBaseOutputMessage,
  TruncatedKnowledgeBaseOutputMessage,
} from "@/modules/rag/knowledge-error-classification";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { fakeLlmProvider, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function extractRequest() {
  return jsonRequest("/api/context/knowledge/extract", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
  });
}

describe("POST /api/context/knowledge/extract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserLLMProvider.mockResolvedValue(fakeLlmProvider());
  });

  it("returns the snapshot and extracts with the trusted scope, actor, and default incremental mode", async () => {
    const snapshot = { provider: "openai", model: "test-model", sections: [] };
    mocks.extractAndSaveProjectKnowledgeBase.mockResolvedValue(snapshot);

    const response = await POST(extractRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(mocks.extractAndSaveProjectKnowledgeBase).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scope: trustedScope, actor: "user-1", mode: "incremental" }),
    );
    expect(mocks.writeGenerationFailureAudit).not.toHaveBeenCalled();
  });

  it("maps a truncation failure to 422 with the truncation guidance and writes the failure audit", async () => {
    mocks.extractAndSaveProjectKnowledgeBase.mockRejectedValue(
      new Error("Response hit the max output token cap."),
    );

    const response = await POST(extractRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: TruncatedKnowledgeBaseOutputMessage });
    expect(mocks.writeGenerationFailureAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scope: trustedScope,
        actor: "user-1",
        action: "rag.extract_project_knowledge_base",
      }),
    );
  });

  it("maps invalid-output failures (ZodError) to 422 with the invalid-output guidance", async () => {
    mocks.extractAndSaveProjectKnowledgeBase.mockRejectedValue(new z.ZodError([]));

    const response = await POST(extractRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: InvalidKnowledgeBaseOutputMessage });
  });

  it("normalizes unclassified provider errors before returning them", async () => {
    mocks.extractAndSaveProjectKnowledgeBase.mockRejectedValue(
      new Error("Azure DevOps rate limit exceeded."),
    );

    const response = await POST(extractRequest());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("The request could not be completed because a rate limit or quota was reached. Wait a moment, then try again.");
    expect(body.technicalDetails).toContain("Azure DevOps rate limit exceeded.");
  });

  // This route has no isAppError branch: AppErrors are classified by message regex like
  // any other Error, so a truncation-shaped AppError gets the guidance, not its userMessage.
  it("classifies an AppError by message regex, ignoring its userMessage and code", async () => {
    mocks.extractAndSaveProjectKnowledgeBase.mockRejectedValue(
      new AppError({
        code: AppErrorCode.TokenLimit,
        message: "Output token budget exhausted.",
        userMessage: "The model ran out of output tokens.",
      }),
    );

    const response = await POST(extractRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: TruncatedKnowledgeBaseOutputMessage });
  });

  it("returns 503 with an AppError's user message when no classifier matches", async () => {
    mocks.extractAndSaveProjectKnowledgeBase.mockRejectedValue(
      new AppError({
        code: AppErrorCode.ProviderUnavailable,
        message: "OpenAI returned 503.",
        userMessage: "The LLM provider is currently unavailable.",
      }),
    );

    const response = await POST(extractRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "The LLM provider is currently unavailable.",
      code: AppErrorCode.ProviderUnavailable,
    });
  });

  it("skips the failure audit when the error happens before the scope is resolved", async () => {
    mocks.resolveProjectScope.mockRejectedValue(new Error("Project not found in this workspace."));

    const response = await POST(extractRequest());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("Project knowledge extraction failed.");
    expect(body.technicalDetails).toContain("Project not found in this workspace.");
    expect(mocks.writeGenerationFailureAudit).not.toHaveBeenCalled();
  });

  it("returns the auth status for workflow-auth failures without auditing or extracting", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(
      new WorkflowAuthError("Only workspace owners and admins can build project knowledge.", 403),
    );

    const response = await POST(extractRequest());

    expect(response.status).toBe(403);
    expect(mocks.writeGenerationFailureAudit).not.toHaveBeenCalled();
    expect(mocks.extractAndSaveProjectKnowledgeBase).not.toHaveBeenCalled();
  });
});
