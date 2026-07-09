import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  getRetrievalTopK: vi.fn(),
  loadTestExecutionEffortData: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/retrieval-config", () => ({
  getRetrievalTopK: mocks.getRetrievalTopK,
}));
vi.mock("@/modules/test-execution-effort/test-execution-effort.data-loader", () => ({
  loadTestExecutionEffortData: mocks.loadTestExecutionEffortData,
}));

import { azureDevOpsIntegrationError } from "@/modules/integrations/azure-devops/azure-devops-error";
import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST as externalPromptPost } from "./external-prompt/route";
import { POST as preparePost } from "./prepare/route";

const trustedScope = projectScope();
const context = {
  userId: "user-1",
  workspace: { id: "ws-1", azureOrgUrl: "https://dev.azure.com/demo" },
};

function body() {
  return {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    storyId: "123",
  };
}

function expiredPatError() {
  return azureDevOpsIntegrationError(
    401,
    JSON.stringify({ message: "TF400813: not authorized" }),
    "_apis/wit/workitems/123?api-version=7.1",
  );
}

describe("test-execution-effort route integration errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue(context);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter());
    mocks.getRetrievalTopK.mockResolvedValue(6);
    mocks.loadTestExecutionEffortData.mockRejectedValue(expiredPatError());
  });

  it("maps prepare integration auth failures to 401 with the integration header", async () => {
    const response = await preparePost(jsonRequest("/api/test-execution-effort/prepare", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
    expect(await response.json()).toEqual({ error: "Test Execution Effort preview failed." });
  });

  it("maps external-prompt integration auth failures to 401 with the integration header", async () => {
    const response = await externalPromptPost(jsonRequest("/api/test-execution-effort/external-prompt", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
    expect(await response.json()).toEqual({
      error: "External LLM Test Execution Effort prompt preparation failed.",
    });
  });
});
