import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(),
  enqueueWorkspaceContextSync: vi.fn(),
}));

vi.mock("@/modules/workspace/workspace-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-request")>();
  return { ...actual, resolveWorkspaceRequest: mocks.resolveWorkspaceRequest };
});
vi.mock("@/modules/jobs/workspace-sync.handler", () => ({
  enqueueWorkspaceContextSync: mocks.enqueueWorkspaceContextSync,
}));

import { SessionError } from "@/modules/auth/session.service";
import { WorkspaceAccessError } from "@/modules/workspace/workspace-access.service";
import { POST } from "./route";

describe("POST /api/workspace/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "admin-1",
      workspace: { id: "ws-1" },
    });
    mocks.enqueueWorkspaceContextSync.mockResolvedValue(2);
  });

  it("enqueues only the server-resolved workspace and actor", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, workspaceId: "ws-1", enqueued: 2 });
    expect(mocks.enqueueWorkspaceContextSync).toHaveBeenCalledWith("ws-1", "admin-1");
  });

  it.each([
    [new SessionError(), 401],
    [new WorkspaceAccessError("Role denied."), 403],
  ])("maps access errors before enqueueing", async (error, status) => {
    mocks.resolveWorkspaceRequest.mockRejectedValue(error);
    const response = await POST();
    expect(response.status).toBe(status);
    expect(mocks.enqueueWorkspaceContextSync).not.toHaveBeenCalled();
  });

  it("rethrows unexpected resolution and enqueue failures", async () => {
    const resolutionFailure = new Error("session store unavailable");
    mocks.resolveWorkspaceRequest.mockRejectedValueOnce(resolutionFailure);
    await expect(POST()).rejects.toBe(resolutionFailure);

    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "admin-1",
      workspace: { id: "ws-1" },
    });
    const enqueueFailure = new Error("queue unavailable");
    mocks.enqueueWorkspaceContextSync.mockRejectedValueOnce(enqueueFailure);
    await expect(POST()).rejects.toBe(enqueueFailure);
  });
});
