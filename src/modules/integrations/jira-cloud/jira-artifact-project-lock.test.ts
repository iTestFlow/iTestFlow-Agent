import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn(), withTransaction: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-08-13T00:00:00.000Z",
  sqlGet: mocks.sqlGet,
  sqlRun: mocks.sqlRun,
  withTransaction: mocks.withTransaction,
}));

import {
  JiraArtifactPublishInProgressError,
  retireStaleJiraArtifactClaims,
  withAuthorizedJiraArtifactConfigurationLock,
  withJiraArtifactProjectLock,
} from "./jira-artifact-project-lock";

describe("Jira artifact project lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation((work: (client: object) => unknown) => work({ tx: true }));
    mocks.sqlRun.mockResolvedValue(0);
  });

  it("serializes a project and retires expired publishing claims before work", async () => {
    const work = vi.fn(async (lock) => {
      await retireStaleJiraArtifactClaims({ workspaceId: "ws-1", projectId: "project-1" }, lock);
      return "done";
    });

    await expect(withJiraArtifactProjectLock({ workspaceId: "ws-1", projectId: "project-1" }, work)).resolves.toBe("done");

    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.sqlRun.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
    expect(mocks.sqlRun.mock.calls[0][1]).toEqual({ lockKey: "4:ws-1:project-1" });
    expect(mocks.sqlRun.mock.calls[0][2]).toEqual({ tx: true });
    expect(mocks.sqlRun.mock.calls[1][0]).toContain("status = 'error'");
    expect(mocks.sqlRun.mock.calls[1][0]).toContain("updated_at < @staleCutoff");
    expect(mocks.sqlRun.mock.calls[1][1]).toMatchObject({
      workspaceId: "ws-1", projectId: "project-1", now: "2026-08-13T00:00:00.000Z",
      staleCutoff: "2026-08-12T23:50:00.000Z",
    });
    expect(work).toHaveBeenCalledWith(expect.objectContaining({ client: { tx: true }, staleCutoff: "2026-08-12T23:50:00.000Z" }));
  });

  it("authorizes owner/admin configuration and rejects a live claim with a typed conflict", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ id: "project-1" }).mockResolvedValueOnce({ id: "claim-1" });

    await expect(withAuthorizedJiraArtifactConfigurationLock({
      workspaceId: "ws-1", projectId: "project-1", actorUserId: "owner-1",
    }, vi.fn())).rejects.toBeInstanceOf(JiraArtifactPublishInProgressError);

    expect(mocks.sqlGet.mock.calls[0][0]).toContain("wm.role IN ('owner', 'admin')");
    expect(mocks.sqlGet.mock.calls[1][0]).toContain("status = 'publishing'");
  });

  it("does not retire stale state before configuration authorization", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined);

    await expect(withAuthorizedJiraArtifactConfigurationLock({
      workspaceId: "ws-1", projectId: "project-1", actorUserId: "member-1",
    }, vi.fn())).rejects.toThrow("not authorized");

    expect(mocks.sqlRun).toHaveBeenCalledOnce();
    expect(mocks.sqlRun.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
  });
});
