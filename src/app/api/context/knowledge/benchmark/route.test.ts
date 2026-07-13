import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  listCases: vi.fn(),
  submitQuestion: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge-benchmark.service", () => ({
  listProjectKnowledgeBenchmarkCases: mocks.listCases,
  submitProjectKnowledgeBenchmarkQuestion: mocks.submitQuestion,
}));

import { jsonRequest, projectScope } from "@/test/factories";
import { PUT } from "./route";

const trustedScope = projectScope();
const scope = { ...trustedScope, workspaceId: "workspace-1" };

describe("PUT /api/context/knowledge/benchmark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "member-1", workspace: { id: "workspace-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.submitQuestion.mockResolvedValue({ id: "case-1", question: "How does checkout approval work?" });
  });

  it("rejects questions that are too short to be meaningful", async () => {
    const response = await PUT(jsonRequest("/api/context/knowledge/benchmark", {
      scope,
      question: "Short text",
    }));

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("allows members to submit a sanitized human QA benchmark question", async () => {
    const response = await PUT(jsonRequest("/api/context/knowledge/benchmark", {
      scope,
      question: "How does checkout approval work?",
    }));

    expect(response.status).toBe(201);
    expect(mocks.submitQuestion).toHaveBeenCalledWith({
      scope: trustedScope,
      question: "How does checkout approval work?",
    });
  });
});
