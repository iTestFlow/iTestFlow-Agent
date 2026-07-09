import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
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

import { azureDevOpsIntegrationError } from "@/modules/integrations/azure-devops/azure-devops-error";
import { workItemNotInProjectMessage } from "@/modules/projects/project-isolation.guard";
import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const context = {
  userId: "user-1",
  workspace: { id: "ws-1", azureOrgUrl: "https://dev.azure.com/demo" },
};

function body(workItemId = "123") {
  return {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    workItemId,
  };
}

describe("POST /api/azure-devops/work-item-details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue(context);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: mocks.fetchWorkItemById,
    }));
    mocks.fetchWorkItemById.mockResolvedValue({ id: "123", title: "Story" });
  });

  it("maps integration auth failures to 401 with the integration header", async () => {
    mocks.fetchWorkItemById.mockRejectedValue(azureDevOpsIntegrationError(
      401,
      JSON.stringify({ message: "TF400813: not authorized" }),
      "_apis/wit/workitems/123?api-version=7.1",
    ));

    const response = await POST(jsonRequest("/api/azure-devops/work-item-details", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
    expect(await response.json()).toEqual({
      error: "Could not load this work item from Azure DevOps. Check the ID, selected project, and connection settings.",
    });
  });

  it("keeps missing work items collapsed to the canonical 404 response", async () => {
    mocks.fetchWorkItemById.mockRejectedValue(azureDevOpsIntegrationError(
      404,
      JSON.stringify({ message: "TF401232: Work item 123 does not exist, or you do not have permissions to read it." }),
      "_apis/wit/workitems/123?api-version=7.1",
    ));

    const response = await POST(jsonRequest("/api/azure-devops/work-item-details", body()));

    expect(response.status).toBe(404);
    expect(response.headers.get("x-itf-error-scope")).toBeNull();
    expect(await response.json()).toEqual({ error: workItemNotInProjectMessage("123") });
  });
});
