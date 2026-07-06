import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  resolveActiveWorkspaceForUser: vi.fn(),
}));

vi.mock("@/modules/auth/session.service", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/modules/workspace/workspace-access.service", () => ({
  getWorkspaceMembership: mocks.getWorkspaceMembership,
}));
vi.mock("@/modules/workspace/workspace.service", () => ({
  resolveActiveWorkspaceForUser: mocks.resolveActiveWorkspaceForUser,
}));

import { GET } from "./route";

describe("GET /api/auth/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an uncached unauthenticated response when no session exists", async () => {
    mocks.getOptionalSession.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/auth/session"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ authenticated: false });
    expect(mocks.resolveActiveWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("revalidates the session's active workspace membership", async () => {
    mocks.getOptionalSession.mockResolvedValue({
      sessionId: "sess-1",
      userId: "user-1",
      activeWorkspaceId: "ws-selected",
    });
    mocks.resolveActiveWorkspaceForUser.mockResolvedValue({
      id: "ws-selected",
      role: "admin",
    });

    const response = await GET(new Request("http://localhost/api/auth/session"));
    expect(mocks.resolveActiveWorkspaceForUser).toHaveBeenCalledWith("user-1", "ws-selected");
    expect(await response.json()).toEqual({
      authenticated: true,
      userId: "user-1",
      membership: { workspaceId: "ws-selected", role: "admin" },
    });
  });

  it("returns null membership for a requested foreign workspace", async () => {
    mocks.getOptionalSession.mockResolvedValue({
      sessionId: "sess-1",
      userId: "user-1",
      activeWorkspaceId: "ws-1",
    });
    mocks.getWorkspaceMembership.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/auth/session?workspaceId=ws-foreign"),
    );
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith("user-1", "ws-foreign");
    expect(await response.json()).toMatchObject({
      authenticated: true,
      membership: null,
    });
    expect(mocks.resolveActiveWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("returns the explicitly requested active membership without exposing its row", async () => {
    mocks.getOptionalSession.mockResolvedValue({
      sessionId: "sess-secret",
      userId: "user-1",
      activeWorkspaceId: "ws-1",
    });
    mocks.getWorkspaceMembership.mockResolvedValue({
      workspaceId: "ws-2",
      userId: "user-1",
      role: "member",
      status: "active",
      internal: "not-public",
    });

    const response = await GET(
      new Request("http://localhost/api/auth/session?workspaceId=ws-2"),
    );
    expect(await response.json()).toEqual({
      authenticated: true,
      userId: "user-1",
      membership: { workspaceId: "ws-2", role: "member" },
    });
  });
});
