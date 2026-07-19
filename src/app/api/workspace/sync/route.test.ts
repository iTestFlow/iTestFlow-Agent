import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(),
  enqueueWorkspaceContextSync: vi.fn(),
  hasHealthyWorkerCapability: vi.fn(),
}));

vi.mock("@/modules/workspace/workspace-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-request")>();
  return { ...actual, resolveWorkspaceRequest: mocks.resolveWorkspaceRequest };
});
vi.mock("@/modules/jobs/workspace-sync.handler", () => ({
  WORKSPACE_CONTEXT_SYNC: "workspace_context_sync",
  enqueueWorkspaceContextSync: mocks.enqueueWorkspaceContextSync,
}));
vi.mock("@/modules/jobs/worker-registry.service", () => ({
  hasHealthyWorkerCapability: mocks.hasHealthyWorkerCapability,
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
    mocks.hasHealthyWorkerCapability.mockResolvedValue(true);
  });

  it("returns 503 without enqueueing when no healthy worker holds the sync capability", async () => {
    mocks.hasHealthyWorkerCapability.mockResolvedValue(false);

    const response = await POST();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({ code: "workspace_sync_unavailable" });
    expect(mocks.hasHealthyWorkerCapability).toHaveBeenCalledWith("workspace_context_sync");
    expect(mocks.enqueueWorkspaceContextSync).not.toHaveBeenCalled();
  });

  it("enqueues only the server-resolved workspace and actor", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, workspaceId: "ws-1", enqueued: 2 });
    // Role guard requires owner/admin.
    expect(mocks.resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
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
