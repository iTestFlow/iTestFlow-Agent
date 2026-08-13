import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn(), audit: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "op-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
  withTransaction: (work: (client: object) => unknown) => work({ transaction: true }),
}));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLogTransactional: mocks.audit }));

import { resolveJiraFieldConflict } from "./jira-conflict-resolution.service";

describe("resolveJiraFieldConflict", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.sqlRun.mockResolvedValue(1); });

  it("lets an active workspace member resolve one field and reactivates only when no conflicts remain", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ mapping_id: "mapping-1", workspace_id: "ws-1", project_id: "project-1", jira_issue_key: "QA-7", local_json: '"Local"', remote_json: '"Remote"' });
    await expect(resolveJiraFieldConflict({
      workspaceId: "ws-1", mappingId: "mapping-1", field: "title", resolution: "use_remote", userId: "user-1",
    })).resolves.toEqual({ resolution: "use_remote", mappingStatus: "conflict" });
    expect(String(mocks.sqlGet.mock.calls[0][0])).toContain("workspace_members");
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("jira_sync_operations") && params.operation === "pull" && params.targetJson === '"Remote"')).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "jira.sync.conflict_resolved", actor: "user:user-1" }), expect.anything());
  });

  it("fails closed for a nonmember or already-resolved field", async () => {
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(resolveJiraFieldConflict({
      workspaceId: "ws-1", mappingId: "mapping-1", field: "title", resolution: "use_local", userId: "outsider",
    })).rejects.toThrow("not available");
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });
});
