import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  destroySession: vi.fn(),
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapterOrgLevel: vi.fn(),
  fetchProjects: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  sqlGet: mocks.sqlGet,
}));
// Keep the real SessionError class so the real authErrorResponse's
// `instanceof SessionError` check still works; only destroySession is stubbed.
vi.mock("@/modules/auth/session.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/session.service")>();
  return {
    ...actual,
    destroySession: mocks.destroySession,
  };
});
// requireWorkflowContext / getUserAzureAdapterOrgLevel are stubbed, but
// authErrorResponse uses the REAL implementation so the route's auth-error ->
// 401/403 mapping is actually exercised (a regression that swallowed an auth
// error into the generic 503 branch would otherwise pass silently).
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    WorkflowAuthError: actual.WorkflowAuthError,
    authErrorResponse: actual.authErrorResponse,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapterOrgLevel: mocks.getUserAzureAdapterOrgLevel,
  };
});

import { SessionError } from "@/modules/auth/session.service";
import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { GET as health } from "./health/route";
import { POST as logout } from "./auth/logout/route";
import { GET as projects } from "./azure-devops/projects/route";

describe("core API route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockResolvedValue({ ok: 1 });
    mocks.destroySession.mockResolvedValue(undefined);
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user",
      workspace: {
        id: "ws",
        azureOrgUrl: "https://dev.azure.com/demo",
      },
    });
    mocks.getUserAzureAdapterOrgLevel.mockResolvedValue({
      fetchProjects: mocks.fetchProjects,
    });
    mocks.fetchProjects.mockResolvedValue([{ id: "p1", name: "Demo" }]);
  });

  it("reports healthy and unhealthy database state without throwing", async () => {
    const healthy = await health();
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ status: "ok", database: "postgres" });

    mocks.sqlGet.mockRejectedValue(new Error("database unavailable"));
    const unhealthy = await health();
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toMatchObject({
      status: "error",
      message: "Database connection failed.",
    });
  });

  it("destroys a session and prevents logout response caching", async () => {
    const response = await logout();
    expect(mocks.destroySession).toHaveBeenCalledOnce();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("maps live projects with server-resolved organization and workspace data", async () => {
    const response = await projects();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "live",
      organizationUrl: "https://dev.azure.com/demo",
      workspaceId: "ws",
      projects: [{
        id: "p1",
        name: "Demo",
        azureOrganizationUrl: "https://dev.azure.com/demo",
        workspaceId: "ws",
      }],
    });
  });

  it("returns a sanitized service failure", async () => {
    mocks.fetchProjects.mockRejectedValue(new Error("Azure unavailable"));
    const response = await projects();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("The service is temporarily unavailable. Try again in a moment.");
    expect(body.technicalDetails).toContain("Azure unavailable");
  });

  it("maps a SessionError to 401 with the sanitized auth body", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new SessionError("Authentication required."));
    const response = await projects();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
  });

  it("maps a WorkflowAuthError to its status (403) with the sanitized auth body", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(
      new WorkflowAuthError("You do not have access to this workspace.", 403),
    );
    const response = await projects();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "You do not have access to this workspace." });
  });
});
