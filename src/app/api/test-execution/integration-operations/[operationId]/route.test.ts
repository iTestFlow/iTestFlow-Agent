import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  authErrorResponse: vi.fn(),
  resolveProjectScope: vi.fn(),
  transitionIntegrationOperation: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
    authErrorResponse: mocks.authErrorResponse,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/test-execution/integration-capabilities.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/test-execution/integration-capabilities.service")>();
  return { ...actual, transitionIntegrationOperation: mocks.transitionIntegrationOperation };
});

import { jsonRequest } from "@/test/factories";
import { IntegrationOperationError } from "@/modules/test-execution/integration-capabilities.service";
import { PATCH } from "./route";

const scope = {
  workspaceId: "ws-1",
  projectId: "project-1",
  azureProjectId: "azure-1",
  azureProjectName: "Project",
  azureOrganizationUrl: "https://dev.azure.com/acme",
};

describe("integration operation revision route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "admin-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.authErrorResponse.mockReturnValue(null);
    mocks.resolveProjectScope.mockResolvedValue({ ...scope, projectId: "trusted" });
    mocks.transitionIntegrationOperation.mockResolvedValue({ id: "operation-2", revision: 2 });
  });

  it("approves an immutable successor revision as owner/admin", async () => {
    const response = await PATCH(
      jsonRequest("/api/test-execution/integration-operations/operation-1", { scope, action: "approve" }),
      { params: Promise.resolve({ operationId: "operation-1" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.transitionIntegrationOperation).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      scope: expect.objectContaining({ projectId: "trusted" }),
      actor: "admin-1",
      operationRevisionId: "operation-1",
      action: "approve",
      changes: {},
    });
  });

  it("returns 404 without leaking another project operation", async () => {
    mocks.transitionIntegrationOperation.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("/api/test-execution/integration-operations/missing", { scope, action: "archive" }),
      { params: Promise.resolve({ operationId: "missing" }) },
    );
    expect(response.status).toBe(404);
  });

  it("rejects unsupported actions before resolving scope", async () => {
    const response = await PATCH(
      jsonRequest("/api/test-execution/integration-operations/operation-1", { scope, action: "delete" }),
      { params: Promise.resolve({ operationId: "operation-1" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveProjectScope).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before resolving scope", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/test-execution/integration-operations/operation-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      { params: Promise.resolve({ operationId: "operation-1" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveProjectScope).not.toHaveBeenCalled();
  });

  it("returns the centralized authentication response", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new Error("not signed in"));
    mocks.authErrorResponse.mockReturnValue(new Response("unauthorized", { status: 401 }));
    const response = await PATCH(
      jsonRequest("/api/test-execution/integration-operations/operation-1", { scope, action: "approve" }),
      { params: Promise.resolve({ operationId: "operation-1" }) },
    );
    expect(response.status).toBe(401);
  });

  it("preserves a curated transition validation status", async () => {
    mocks.transitionIntegrationOperation.mockRejectedValue(new IntegrationOperationError("Stale revision.", 409));
    const response = await PATCH(
      jsonRequest("/api/test-execution/integration-operations/operation-1", { scope, action: "approve" }),
      { params: Promise.resolve({ operationId: "operation-1" }) },
    );
    expect(response.status).toBe(409);
  });

  it("uses a safe fallback for unexpected transition failures", async () => {
    mocks.transitionIntegrationOperation.mockRejectedValue(new Error("database secret detail"));
    const response = await PATCH(
      jsonRequest("/api/test-execution/integration-operations/operation-1", { scope, action: "approve" }),
      { params: Promise.resolve({ operationId: "operation-1" }) },
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("The integration operation could not be updated.");
  });
});
