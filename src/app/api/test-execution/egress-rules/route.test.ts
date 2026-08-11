import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  authErrorResponse: vi.fn(),
  listWorkspaceEgressRules: vi.fn(),
  createWorkspaceEgressRule: vi.fn(),
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
vi.mock("@/modules/test-execution/egress-policy.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/test-execution/egress-policy.service")>();
  return {
    ...actual,
    listWorkspaceEgressRules: mocks.listWorkspaceEgressRules,
    createWorkspaceEgressRule: mocks.createWorkspaceEgressRule,
  };
});

import { jsonRequest } from "@/test/factories";
import { TestExecutionEgressError } from "@/modules/test-execution/egress-policy.service";
import { GET, POST } from "./route";

const rule = {
  name: "QA API",
  targetKind: "api",
  protocol: "https",
  hostPattern: "api.example.com",
  portFrom: 443,
  portTo: 443,
  allowPrivateNetwork: false,
  enabled: true,
} as const;

describe("test execution egress-rule collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "admin-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.authErrorResponse.mockReturnValue(null);
    mocks.listWorkspaceEgressRules.mockResolvedValue([]);
    mocks.createWorkspaceEgressRule.mockResolvedValue({ id: "rule-1", ...rule });
  });

  it("requires owner/admin to list the workspace policy", async () => {
    const response = await GET(new Request("http://localhost/api/test-execution/egress-rules?workspaceId=ws-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.requireWorkflowRole).toHaveBeenCalledWith(
      expect.anything(),
      ["owner", "admin"],
      expect.any(String),
    );
    expect(mocks.listWorkspaceEgressRules).toHaveBeenCalledWith("ws-1");
  });

  it("creates a rule with server-resolved workspace and actor", async () => {
    const response = await POST(jsonRequest("/api/test-execution/egress-rules", { workspaceId: "ws-1", rule }));
    expect(response.status).toBe(201);
    expect(mocks.createWorkspaceEgressRule).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actor: "admin-1",
      rule,
    });
  });

  it("rejects malformed rules before authentication", async () => {
    const response = await POST(jsonRequest("/api/test-execution/egress-rules", {
      workspaceId: "ws-1",
      rule: { ...rule, portFrom: 9000, portTo: 8000 },
    }));
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects a list request without a workspace", async () => {
    const response = await GET(new Request("http://localhost/api/test-execution/egress-rules"));
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("returns the centralized authentication response", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new Error("not signed in"));
    mocks.authErrorResponse.mockReturnValue(new Response("unauthorized", { status: 401 }));
    const response = await GET(new Request("http://localhost/api/test-execution/egress-rules?workspaceId=ws-1"));
    expect(response.status).toBe(401);
  });

  it("preserves the curated status of a policy validation error", async () => {
    mocks.createWorkspaceEgressRule.mockRejectedValue(new TestExecutionEgressError("Invalid rule.", 422));
    const response = await POST(jsonRequest("/api/test-execution/egress-rules", { workspaceId: "ws-1", rule }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Invalid rule." });
  });

  it("uses a safe fallback for unexpected creation failures", async () => {
    mocks.createWorkspaceEgressRule.mockRejectedValue(new Error("database password leaked"));
    const response = await POST(jsonRequest("/api/test-execution/egress-rules", { workspaceId: "ws-1", rule }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("The egress rule could not be created.");
  });
});
