import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  authErrorResponse: vi.fn(),
  resolveProjectScope: vi.fn(),
  listIntegrationOperations: vi.fn(),
  createIntegrationOperation: vi.fn(),
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
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/test-execution/integration-capabilities.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/test-execution/integration-capabilities.service")>();
  return {
    ...actual,
    listIntegrationOperations: mocks.listIntegrationOperations,
    createIntegrationOperation: mocks.createIntegrationOperation,
  };
});

import { jsonRequest } from "@/test/factories";
import { IntegrationOperationError } from "@/modules/test-execution/integration-capabilities.service";
import { GET, POST } from "./route";

const scope = {
  workspaceId: "ws-1",
  projectId: "project-1",
  azureProjectId: "azure-1",
  azureProjectName: "Project",
  azureOrganizationUrl: "https://dev.azure.com/acme",
};
const trustedScope = { ...scope, projectId: "trusted-project" };

function query(includeAll = false) {
  const params = new URLSearchParams({ ...scope, ...(includeAll ? { includeAll: "true" } : {}) });
  return new Request(`http://localhost/api/test-execution/integration-operations?${params}`);
}

describe("integration operation collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.authErrorResponse.mockReturnValue(null);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.listIntegrationOperations.mockResolvedValue([]);
    mocks.createIntegrationOperation.mockResolvedValue({ id: "operation-1", approvalStatus: "draft" });
  });

  it("lets members list approved capabilities without the elevated role guard", async () => {
    const response = await GET(query());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.requireWorkflowRole).not.toHaveBeenCalled();
    expect(mocks.listIntegrationOperations).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      scope: trustedScope,
      includeAll: false,
    });
  });

  it("requires owner/admin before listing drafts and archives", async () => {
    const response = await GET(query(true));
    expect(response.status).toBe(200);
    expect(mocks.requireWorkflowRole).toHaveBeenCalledWith(
      expect.anything(),
      ["owner", "admin"],
      expect.stringContaining("draft or archived"),
    );
    expect(mocks.listIntegrationOperations).toHaveBeenCalledWith(expect.objectContaining({ includeAll: true }));
  });

  it("creates a draft with trusted scope and actor after role authorization", async () => {
    const operation = {
      stableKey: "api.get_customer",
      displayName: "Get customer",
      layer: "api",
      sourceKind: "manual",
      safetyClass: "read",
      databaseDriver: null,
      apiContractRevisionId: null,
      parameterSchema: {},
      definition: { method: "GET", path: "/customers/{id}" },
    };
    const response = await POST(jsonRequest("/api/test-execution/integration-operations", { scope, operation }));
    expect(response.status).toBe(201);
    expect(mocks.requireWorkflowRole).toHaveBeenCalledWith(
      expect.anything(),
      ["owner", "admin"],
      expect.any(String),
    );
    expect(mocks.createIntegrationOperation).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      scope: trustedScope,
      actor: "user-1",
      operation,
    });
  });

  it("rejects malformed operations before authentication or persistence", async () => {
    const response = await POST(jsonRequest("/api/test-execution/integration-operations", {
      scope,
      operation: { stableKey: "INVALID KEY" },
    }));
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.createIntegrationOperation).not.toHaveBeenCalled();
  });

  it("rejects an invalid project query before authentication", async () => {
    const response = await GET(new Request("http://localhost/api/test-execution/integration-operations"));
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("returns the centralized authentication response", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new Error("not signed in"));
    mocks.authErrorResponse.mockReturnValue(new Response("unauthorized", { status: 401 }));
    const response = await GET(query());
    expect(response.status).toBe(401);
  });

  it("preserves a curated operation validation status", async () => {
    const operation = {
      stableKey: "api.get_customer",
      displayName: "Get customer",
      layer: "api",
      sourceKind: "manual",
      safetyClass: "read",
      databaseDriver: null,
      apiContractRevisionId: null,
      parameterSchema: {},
      definition: { method: "GET", path: "/customers/{id}" },
    };
    mocks.createIntegrationOperation.mockRejectedValue(new IntegrationOperationError("Invalid operation.", 422));
    const response = await POST(jsonRequest("/api/test-execution/integration-operations", { scope, operation }));
    expect(response.status).toBe(422);
  });

  it("uses a safe fallback for unexpected list failures", async () => {
    mocks.listIntegrationOperations.mockRejectedValue(new Error("database secret detail"));
    const response = await GET(query());
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Integration operations could not be loaded.");
  });
});
