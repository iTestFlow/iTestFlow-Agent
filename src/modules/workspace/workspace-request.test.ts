import { beforeEach, describe, expect, it, vi } from "vitest";

// The error classes are re-declared inside the mock factories so the module
// under test and the assertions share the exact references its `instanceof`
// mapping in workspaceRequestError relies on.
const sessionService = vi.hoisted(() => {
  class SessionError extends Error {
    constructor(message = "Authentication required.") {
      super(message);
      this.name = "SessionError";
    }
  }
  return { requireSession: vi.fn(), SessionError };
});

const workspaceService = vi.hoisted(() => ({
  resolveActiveWorkspaceForUser: vi.fn(),
}));

const accessService = vi.hoisted(() => {
  class WorkspaceAccessError extends Error {
    constructor(message = "You do not have access to this workspace.") {
      super(message);
      this.name = "WorkspaceAccessError";
    }
  }
  return {
    requireWorkspaceAccess: vi.fn(),
    requireWorkspaceRole: vi.fn(),
    WorkspaceAccessError,
  };
});

vi.mock("@/modules/auth/session.service", () => sessionService);
vi.mock("./workspace.service", () => workspaceService);
vi.mock("./workspace-access.service", () => accessService);

import { resolveWorkspaceRequest, workspaceRequestError } from "./workspace-request";

const session = { sessionId: "sess-1", userId: "user-1", activeWorkspaceId: "ws-login" };
const workspace = {
  id: "ws-1",
  name: "Acme",
  azureOrgName: "acme",
  azureOrgUrl: "https://dev.azure.com/acme",
  role: "member" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionService.requireSession.mockResolvedValue(session);
  workspaceService.resolveActiveWorkspaceForUser.mockResolvedValue(workspace);
  accessService.requireWorkspaceAccess.mockResolvedValue({ role: "member" });
  accessService.requireWorkspaceRole.mockResolvedValue({ role: "owner" });
});

describe("resolveWorkspaceRequest", () => {
  it("with no roles enforces membership only, never a role check", async () => {
    await expect(resolveWorkspaceRequest()).resolves.toEqual({ userId: "user-1", workspace });
    expect(accessService.requireWorkspaceAccess).toHaveBeenCalledWith("user-1", "ws-1");
    expect(accessService.requireWorkspaceRole).not.toHaveBeenCalled();
  });

  it("with an empty roles list still uses the plain membership check", async () => {
    await resolveWorkspaceRequest([]);
    expect(accessService.requireWorkspaceAccess).toHaveBeenCalledWith("user-1", "ws-1");
    expect(accessService.requireWorkspaceRole).not.toHaveBeenCalled();
  });

  it("forwards exactly the required roles to requireWorkspaceRole and skips the plain access check", async () => {
    await resolveWorkspaceRequest(["owner", "admin"]);
    expect(accessService.requireWorkspaceRole).toHaveBeenCalledWith("user-1", "ws-1", ["owner", "admin"]);
    expect(accessService.requireWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("resolves the workspace for the session user and their login-selected org", async () => {
    await resolveWorkspaceRequest();
    expect(workspaceService.resolveActiveWorkspaceForUser).toHaveBeenCalledWith("user-1", "ws-login");
  });

  it("returns the context carrying the resolved workspace and its role", async () => {
    const context = await resolveWorkspaceRequest(["owner"]);
    expect(context.userId).toBe("user-1");
    expect(context.workspace).toMatchObject({ id: "ws-1", name: "Acme", role: "member" });
  });

  it("rejects with WorkspaceAccessError before any access check when the user has no workspace", async () => {
    workspaceService.resolveActiveWorkspaceForUser.mockResolvedValue(null);
    await expect(resolveWorkspaceRequest(["owner"])).rejects.toThrow(
      "No workspace membership found for this user.",
    );
    expect(accessService.requireWorkspaceAccess).not.toHaveBeenCalled();
    expect(accessService.requireWorkspaceRole).not.toHaveBeenCalled();
  });

  it("propagates a role-check denial unchanged", async () => {
    const denial = new accessService.WorkspaceAccessError(
      "Your workspace role is not permitted to perform this action.",
    );
    accessService.requireWorkspaceRole.mockRejectedValue(denial);
    await expect(resolveWorkspaceRequest(["owner"])).rejects.toBe(denial);
  });
});

describe("workspaceRequestError", () => {
  it("maps a requireSession failure to 401 with the error message", async () => {
    sessionService.requireSession.mockRejectedValue(new sessionService.SessionError());
    const error = await resolveWorkspaceRequest().catch((caught) => caught);
    const response = workspaceRequestError(error);
    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({ error: "Authentication required." });
  });

  it("maps a workspace access failure to 403 with the error message", async () => {
    accessService.requireWorkspaceAccess.mockRejectedValue(
      new accessService.WorkspaceAccessError(),
    );
    const error = await resolveWorkspaceRequest().catch((caught) => caught);
    const response = workspaceRequestError(error);
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "You do not have access to this workspace.",
    });
  });

  it("maps the missing-workspace rejection to 403", async () => {
    workspaceService.resolveActiveWorkspaceForUser.mockResolvedValue(null);
    const error = await resolveWorkspaceRequest().catch((caught) => caught);
    const response = workspaceRequestError(error);
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "No workspace membership found for this user.",
    });
  });

  it("returns null for errors it does not own, so callers rethrow", () => {
    expect(workspaceRequestError(new Error("boom"))).toBeNull();
    expect(workspaceRequestError("not an error")).toBeNull();
  });
});
