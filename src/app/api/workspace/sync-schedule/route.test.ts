import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(),
  getWorkspaceSyncSchedule: vi.fn(),
  upsertWorkspaceSyncSchedule: vi.fn(),
  deleteWorkspaceSyncSchedule: vi.fn(),
}));

vi.mock("@/modules/workspace/workspace-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-request")>();
  return { ...actual, resolveWorkspaceRequest: mocks.resolveWorkspaceRequest };
});
vi.mock("@/modules/jobs/sync-schedule.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/jobs/sync-schedule.service")>();
  return {
    ...actual,
    getWorkspaceSyncSchedule: mocks.getWorkspaceSyncSchedule,
    upsertWorkspaceSyncSchedule: mocks.upsertWorkspaceSyncSchedule,
    deleteWorkspaceSyncSchedule: mocks.deleteWorkspaceSyncSchedule,
  };
});

import { ScheduleError } from "@/modules/jobs/sync-schedule.service";
import { WorkspaceAccessError } from "@/modules/workspace/workspace-access.service";
import { jsonRequest } from "@/test/factories";
import { DELETE, GET, PUT } from "./route";

describe("workspace sync schedule routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "admin-1",
      workspace: { id: "ws-1" },
    });
    mocks.getWorkspaceSyncSchedule.mockResolvedValue(null);
    mocks.upsertWorkspaceSyncSchedule.mockResolvedValue({
      cronExpression: "0 2 * * *",
      enabled: true,
      nextRunAt: "2026-07-07T02:00:00.000Z",
      lastEnqueuedAt: null,
      workItemTypes: ["User Story"],
      states: ["Active"],
    });
  });

  it("returns an uncached workspace-scoped schedule", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ workspaceId: "ws-1", schedule: null });
    // Role guard requires owner/admin.
    expect(mocks.resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
    expect(mocks.getWorkspaceSyncSchedule).toHaveBeenCalledWith("ws-1");
  });

  it("stores a validated schedule with trusted ownership", async () => {
    const response = await PUT(jsonRequest("/api/workspace/sync-schedule", {
      cronExpression: "0 2 * * *",
      enabled: true,
      workItemTypes: ["User Story"],
      states: ["Active"],
    }));
    expect(response.status).toBe(200);
    // Role guard requires owner/admin.
    expect(mocks.resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
    expect(mocks.upsertWorkspaceSyncSchedule).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      cronExpression: "0 2 * * *",
      enabled: true,
      workItemTypes: ["User Story"],
      states: ["Active"],
      createdByUserId: "admin-1",
    });
  });

  it("applies default filters when only a cron expression is posted", async () => {
    const response = await PUT(jsonRequest("/api/workspace/sync-schedule", {
      cronExpression: "0 2 * * *",
    }));
    expect(response.status).toBe(200);
    expect(mocks.upsertWorkspaceSyncSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        workItemTypes: expect.any(Array),
        states: expect.any(Array),
      }),
    );
  });

  it("rejects malformed input before invoking the schedule service", async () => {
    const response = await PUT(jsonRequest("/api/workspace/sync-schedule", {
      cronExpression: "",
    }));
    expect(response.status).toBe(400);
    expect(mocks.upsertWorkspaceSyncSchedule).not.toHaveBeenCalled();
  });

  it("maps malformed JSON through the same validation response", async () => {
    const response = await PUT(new Request("http://localhost/api/workspace/sync-schedule", {
      method: "PUT",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(400);
    expect(mocks.upsertWorkspaceSyncSchedule).not.toHaveBeenCalled();
  });

  it("maps schedule validation errors to their declared status", async () => {
    mocks.upsertWorkspaceSyncSchedule.mockRejectedValue(
      new ScheduleError("Invalid cron.", 422),
    );
    const response = await PUT(jsonRequest("/api/workspace/sync-schedule", {
      cronExpression: "bad cron",
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Invalid cron." });
  });

  it("deletes only the active workspace schedule", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // Role guard requires owner/admin.
    expect(mocks.resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
    expect(mocks.deleteWorkspaceSyncSchedule).toHaveBeenCalledWith("ws-1");
  });

  it("maps denied administration before reading or writing schedules", async () => {
    mocks.resolveWorkspaceRequest.mockRejectedValue(new WorkspaceAccessError("Role denied."));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.getWorkspaceSyncSchedule).not.toHaveBeenCalled();
  });

  it("maps denied administration for PUT and DELETE as well", async () => {
    mocks.resolveWorkspaceRequest.mockRejectedValue(new WorkspaceAccessError("Role denied."));
    const put = await PUT(jsonRequest("/api/workspace/sync-schedule", {
      cronExpression: "0 2 * * *",
    }));
    expect(put.status).toBe(403);
    const remove = await DELETE();
    expect(remove.status).toBe(403);
    expect(mocks.upsertWorkspaceSyncSchedule).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceSyncSchedule).not.toHaveBeenCalled();
  });

  it("rethrows unexpected access and schedule failures", async () => {
    const accessFailure = new Error("session store unavailable");
    mocks.resolveWorkspaceRequest.mockRejectedValueOnce(accessFailure);
    await expect(GET()).rejects.toBe(accessFailure);

    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "admin-1",
      workspace: { id: "ws-1" },
    });
    const upsertFailure = new Error("schedule write failed");
    mocks.upsertWorkspaceSyncSchedule.mockRejectedValueOnce(upsertFailure);
    await expect(PUT(jsonRequest("/api/workspace/sync-schedule", {
      cronExpression: "0 2 * * *",
    }))).rejects.toBe(upsertFailure);
  });
});
