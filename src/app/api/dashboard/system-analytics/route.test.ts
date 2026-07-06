import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  getSystemDashboardAnalytics: vi.fn(),
  getSystemDashboardUserLabel: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/workspace/workspace-access.service", () => ({
  getWorkspaceMembership: mocks.getWorkspaceMembership,
}));
vi.mock("@/modules/analytics/system-dashboard.service", () => ({
  getSystemDashboardAnalytics: mocks.getSystemDashboardAnalytics,
  getSystemDashboardUserLabel: mocks.getSystemDashboardUserLabel,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function analyticsRequest(filters: Record<string, unknown> = {}) {
  return jsonRequest("/api/dashboard/system-analytics", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    filters,
  });
}

describe("POST /api/dashboard/system-analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getWorkspaceMembership.mockResolvedValue({ role: "member" });
    mocks.getSystemDashboardAnalytics.mockResolvedValue({ totals: { workflowRuns: 3 } });
    mocks.getSystemDashboardUserLabel.mockResolvedValue("Ada Lovelace");
  });

  it("forces a member request to the authenticated user's analytics scope", async () => {
    const response = await POST(analyticsRequest({ datePreset: "30d", userId: "other-user" }));

    expect(response.status).toBe(200);
    expect(mocks.getSystemDashboardAnalytics).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      filters: { datePreset: "30d", userId: "user-1" },
      userOptionsUserId: "user-1",
    });
    expect(mocks.getSystemDashboardUserLabel).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      permissions: { canViewWorkspaceUsers: false },
      effectiveScope: { mode: "mine", label: "My activity", userId: "user-1" },
    });
  });

  it("allows an owner to request another user's analytics and returns a trusted label", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue({ role: "owner" });

    const response = await POST(analyticsRequest({ userId: "user-2" }));

    expect(mocks.getSystemDashboardUserLabel).toHaveBeenCalledExactlyOnceWith("ws-1", "user-2");
    expect(mocks.getSystemDashboardAnalytics).toHaveBeenCalledWith({
      scope: trustedScope,
      filters: { userId: "user-2" },
      userOptionsUserId: null,
    });
    expect(await response.json()).toMatchObject({
      permissions: { canViewWorkspaceUsers: true },
      effectiveScope: { mode: "user", label: "Ada Lovelace", userId: "user-2" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects malformed JSON and invalid custom date ranges before authentication", async () => {
    const malformed = new Request("http://localhost/api/dashboard/system-analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const malformedResponse = await POST(malformed);
    const missingRangeResponse = await POST(analyticsRequest({
      datePreset: "custom",
    }));
    const rangeResponse = await POST(analyticsRequest({
      datePreset: "custom",
      from: "2026-07-31",
      to: "2026-07-01",
    }));

    expect(malformedResponse.status).toBe(400);
    expect(missingRangeResponse.status).toBe(400);
    expect(await missingRangeResponse.json()).toEqual({
      error: "Custom ranges require start and end dates.",
    });
    expect(rangeResponse.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("preserves authorization status and does not query analytics after access fails", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(
      new WorkflowAuthError("Workspace membership required.", 403),
    );

    const response = await POST(analyticsRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Workspace membership required." });
    expect(mocks.getSystemDashboardAnalytics).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when the analytics query fails", async () => {
    mocks.getSystemDashboardAnalytics.mockRejectedValue(new Error("analytics store unavailable"));

    const response = await POST(analyticsRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "analytics store unavailable" });
  });
});
