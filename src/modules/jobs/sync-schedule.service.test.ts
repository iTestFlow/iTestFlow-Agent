import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createId: vi.fn(() => "schedule-1"),
  nowIso: vi.fn(() => "2026-07-06T00:00:00.000Z"),
  sqlAll: vi.fn(),
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  withTransaction: vi.fn(async (callback: (client: unknown) => unknown) =>
    callback({ query: vi.fn() }),
  ),
}));
const sync = vi.hoisted(() => ({
  enqueueWorkspaceContextSync: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => database);
vi.mock("./workspace-sync.handler", () => ({
  enqueueWorkspaceContextSync: sync.enqueueWorkspaceContextSync,
}));

import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults";
import { enqueueDueScheduledSyncs } from "./sync-schedule.service";

describe("enqueueDueScheduledSyncs failure isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.sqlRun.mockResolvedValue(1);
  });

  it("advances every claimed schedule and continues after one workspace enqueue fails", async () => {
    database.sqlAll.mockResolvedValue([
      {
        id: "schedule-1",
        workspace_id: "ws-1",
        cron_expression: "0 2 * * *",
        work_item_types: JSON.stringify(["Bug"]),
        states: JSON.stringify(["Active"]),
      },
      {
        id: "schedule-2",
        workspace_id: "ws-2",
        cron_expression: "0 3 * * *",
        work_item_types: "not-json",
        states: null,
      },
    ]);
    sync.enqueueWorkspaceContextSync
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(1);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(enqueueDueScheduledSyncs()).resolves.toBe(2);
    // Both claimed rows get their next_run_at advanced, keyed by their own id.
    expect(database.sqlRun).toHaveBeenCalledTimes(2);
    expect(database.sqlRun).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET next_run_at = @next"),
      expect.objectContaining({ id: "schedule-1" }),
      expect.anything(),
    );
    expect(database.sqlRun).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET next_run_at = @next"),
      expect.objectContaining({ id: "schedule-2" }),
      expect.anything(),
    );
    expect(sync.enqueueWorkspaceContextSync).toHaveBeenNthCalledWith(
      1,
      "ws-1",
      null,
      { workItemTypes: ["Bug"], states: ["Active"] },
    );
    // Unparseable/null filter columns fall back to the shared defaults, exactly.
    expect(sync.enqueueWorkspaceContextSync).toHaveBeenNthCalledWith(
      2,
      "ws-2",
      null,
      { workItemTypes: DEFAULT_CONTEXT_WORK_ITEM_TYPES, states: DEFAULT_CONTEXT_STATES },
    );
    expect(errorLog).toHaveBeenCalledWith(
      "[scheduler] failed to enqueue sync for workspace ws-1",
      expect.any(Error),
    );
  });

  it("does no enqueue work when no schedules are due", async () => {
    database.sqlAll.mockResolvedValue([]);
    await expect(enqueueDueScheduledSyncs()).resolves.toBe(0);
    expect(database.sqlRun).not.toHaveBeenCalled();
    expect(sync.enqueueWorkspaceContextSync).not.toHaveBeenCalled();
  });
});
