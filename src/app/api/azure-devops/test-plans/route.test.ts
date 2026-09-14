import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  authErrorResponse: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchTestPlans: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", () => ({
  requireWorkflowContext: mocks.requireWorkflowContext,
  getUserAzureAdapter: mocks.getUserAzureAdapter,
  authErrorResponse: mocks.authErrorResponse,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));

import { IntegrationError } from "@/modules/integrations/core/integration-error";
import { POST } from "./route";

const scope = {
  workspaceId: "ws-1",
  projectId: "project-1",
  azureProjectId: "project-1",
  azureProjectName: "Demo",
  azureOrganizationUrl: "https://dev.azure.com/demo",
};

function request() {
  return new Request("http://localhost/api/azure-devops/test-plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope }),
  });
}

describe("POST /api/azure-devops/test-plans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(scope);
    mocks.authErrorResponse.mockReturnValue(null);
    mocks.getUserAzureAdapter.mockResolvedValue({ fetchTestPlans: mocks.fetchTestPlans });
  });

  it("surfaces the Jira missing-backend guidance verbatim as an actionable 409", async () => {
    mocks.fetchTestPlans.mockRejectedValue(new IntegrationError({
      providerId: "jira-cloud",
      code: "integration_unsupported_capability",
      message:
        "This test management operation requires a configured backend and is not yet available for Jira Cloud projects. A workspace owner or admin can choose Plain Jira, Xray, or Zephyr Scale in Settings → Connections.",
    }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("Settings → Connections");
    expect(body.error).not.toContain("Azure Test Plan fetch failed");
  });

  it("keeps the Azure fallback for generic failures", async () => {
    mocks.fetchTestPlans.mockRejectedValue(new Error("socket hang up"));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("Azure Test Plan fetch failed.");
  });
});
