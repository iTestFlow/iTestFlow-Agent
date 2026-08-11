import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  authErrorResponse: vi.fn(),
  updateWorkspaceEgressRule: vi.fn(),
  deleteWorkspaceEgressRule: vi.fn(),
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
    updateWorkspaceEgressRule: mocks.updateWorkspaceEgressRule,
    deleteWorkspaceEgressRule: mocks.deleteWorkspaceEgressRule,
  };
});

import { jsonRequest } from "@/test/factories";
import { TestExecutionEgressError } from "@/modules/test-execution/egress-policy.service";
import { DELETE, PATCH } from "./route";

const params = { params: Promise.resolve({ ruleId: "rule-1" }) };

describe("test execution egress-rule item route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "admin-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.authErrorResponse.mockReturnValue(null);
    mocks.updateWorkspaceEgressRule.mockResolvedValue({ id: "rule-1", enabled: false });
    mocks.deleteWorkspaceEgressRule.mockResolvedValue(true);
  });

  it("disables a rule with the trusted workspace actor", async () => {
    const response = await PATCH(
      jsonRequest("/api/test-execution/egress-rules/rule-1", {
        workspaceId: "ws-1",
        changes: { enabled: false },
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(mocks.updateWorkspaceEgressRule).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actor: "admin-1",
      ruleId: "rule-1",
      changes: { enabled: false },
    });
  });

  it("deletes an existing rule", async () => {
    const response = await DELETE(
      jsonRequest("/api/test-execution/egress-rules/rule-1", { workspaceId: "ws-1" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it("rejects empty changes before authorization", async () => {
    const response = await PATCH(
      jsonRequest("/api/test-execution/egress-rules/rule-1", { workspaceId: "ws-1", changes: {} }),
      params,
    );
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("returns 404 when an update cannot see the scoped rule", async () => {
    mocks.updateWorkspaceEgressRule.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("/api/test-execution/egress-rules/rule-1", { workspaceId: "ws-1", changes: { enabled: false } }),
      params,
    );
    expect(response.status).toBe(404);
  });

  it("rejects a delete without a workspace before authorization", async () => {
    const response = await DELETE(jsonRequest("/api/test-execution/egress-rules/rule-1", {}), params);
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("returns 404 when a scoped delete finds no rule", async () => {
    mocks.deleteWorkspaceEgressRule.mockResolvedValue(false);
    const response = await DELETE(
      jsonRequest("/api/test-execution/egress-rules/rule-1", { workspaceId: "ws-1" }),
      params,
    );
    expect(response.status).toBe(404);
  });

  it("returns the centralized authentication response", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new Error("not signed in"));
    mocks.authErrorResponse.mockReturnValue(new Response("unauthorized", { status: 401 }));
    const response = await DELETE(
      jsonRequest("/api/test-execution/egress-rules/rule-1", { workspaceId: "ws-1" }),
      params,
    );
    expect(response.status).toBe(401);
  });

  it("preserves a curated policy update error", async () => {
    mocks.updateWorkspaceEgressRule.mockRejectedValue(new TestExecutionEgressError("Invalid rule.", 422));
    const response = await PATCH(
      jsonRequest("/api/test-execution/egress-rules/rule-1", { workspaceId: "ws-1", changes: { enabled: false } }),
      params,
    );
    expect(response.status).toBe(422);
  });

  it("uses a safe fallback for unexpected delete failures", async () => {
    mocks.deleteWorkspaceEgressRule.mockRejectedValue(new Error("secret backend detail"));
    const response = await DELETE(
      jsonRequest("/api/test-execution/egress-rules/rule-1", { workspaceId: "ws-1" }),
      params,
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("The egress rule could not be deleted.");
  });
});
