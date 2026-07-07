import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  verifyAndUpsertWorkspaceProject: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  verifyAndUpsertWorkspaceProject: mocks.verifyAndUpsertWorkspaceProject,
}));

import { SessionError } from "@/modules/auth/session.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

describe("POST /api/azure-devops/project/select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1" },
    });
    mocks.verifyAndUpsertWorkspaceProject.mockResolvedValue(projectScope());
  });

  it("rejects malformed JSON and missing project IDs before authentication", async () => {
    const malformed = await POST(new Request("http://localhost/api/azure-devops/project/select", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.status).toBe(400);

    const missing = await POST(jsonRequest("/api/azure-devops/project/select", {}));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Select an Azure DevOps project." });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("verifies and returns a server-owned project scope", async () => {
    const response = await POST(jsonRequest("/api/azure-devops/project/select", {
      workspaceId: "ws-1",
      azureProjectId: "azure-project-1",
    }));

    expect(mocks.requireWorkflowContext).toHaveBeenCalledWith("ws-1");
    expect(mocks.verifyAndUpsertWorkspaceProject).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "azure-project-1",
    );
    expect(await response.json()).toEqual({ scope: projectScope() });
  });

  it("maps authentication failures without touching Azure project verification", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new SessionError());
    const response = await POST(jsonRequest("/api/azure-devops/project/select", {
      azureProjectId: "azure-project-1",
    }));

    expect(response.status).toBe(401);
    expect(mocks.verifyAndUpsertWorkspaceProject).not.toHaveBeenCalled();
  });

  it("maps verification failures to a sanitized service response", async () => {
    mocks.verifyAndUpsertWorkspaceProject.mockRejectedValue(new Error("Project unavailable"));
    const response = await POST(jsonRequest("/api/azure-devops/project/select", {
      azureProjectId: "azure-project-1",
    }));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("The service is temporarily unavailable. Try again in a moment.");
    expect(body.technicalDetails).toContain("Project unavailable");
  });
});
