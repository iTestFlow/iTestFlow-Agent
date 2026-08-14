import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn(), audit: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (() => { let count = 0; return () => `id-${++count}`; })(),
  nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
  withTransaction: (work: (client: object) => unknown) => work({ transaction: true }),
}));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLogTransactional: mocks.audit }));

import { reconcileJiraMapping } from "./jira-reconciliation.service";

describe("reconcileJiraMapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockResolvedValue({ id: "mapping-1", workspace_id: "ws-1", project_id: "project-1", jira_issue_key: "QA-7", direction: "two_way" });
    mocks.sqlRun.mockResolvedValue(1);
  });

  it("persists field baselines and exposes deterministic pull/push work when conflict-free", async () => {
    await expect(reconcileJiraMapping({
      workspaceId: "ws-1", mappingId: "mapping-1", actor: "sync:user-1",
      baseline: { title: "Old", state: "Open" }, local: { title: "Local", state: "Open" }, remote: { title: "Old", state: "Done" },
    })).resolves.toMatchObject({ blocked: false, pulls: { state: "Done" }, pushes: { title: "Local" } });
    expect(mocks.sqlRun.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO jira_sync_field_states"))).toBe(true);
    expect(mocks.sqlRun.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO jira_sync_operations"))).toHaveLength(2);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "jira.sync.queued", status: "Pending" }), expect.anything());
  });

  it("blocks every outbound write and records visible field conflicts", async () => {
    const result = await reconcileJiraMapping({
      workspaceId: "ws-1", mappingId: "mapping-1", actor: "sync:user-1",
      baseline: { title: "Old", state: "Open" }, local: { title: "Local", state: "Local State" }, remote: { title: "Remote", state: "Open" },
    });
    expect(result).toMatchObject({ blocked: true, pushes: {}, conflicts: [{ field: "title" }] });
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("jira_sync_field_states") && params.status === "conflict")).toBe(true);
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("UPDATE jira_sync_mappings") && params.status === "conflict")).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "jira.sync.conflict", status: "Pending" }), expect.anything());
  });

  it("fails closed when the mapping does not belong to the workspace", async () => {
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(reconcileJiraMapping({
      workspaceId: "ws-other", mappingId: "mapping-1", actor: "sync:user-1", baseline: {}, local: {}, remote: {},
    })).rejects.toThrow("not available");
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("treats Jira as authoritative for a Jira-to-iTestFlow mapping", async () => {
    mocks.sqlGet.mockResolvedValue({ id: "mapping-1", workspace_id: "ws-1", project_id: "project-1", jira_issue_key: "QA-7", direction: "jira_to_itestflow" });
    const result = await reconcileJiraMapping({
      workspaceId: "ws-1", mappingId: "mapping-1", actor: "sync:user-1",
      baseline: { title: "Old" }, local: { title: "Local" }, remote: { title: "Remote" },
    });
    expect(result).toMatchObject({ blocked: false, pulls: { title: "Remote" }, pushes: {}, conflicts: [] });
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("jira_sync_field_states") && params.baselineJson === '"Old"' && params.status === "pending")).toBe(true);
  });

  it("queues field deletion without collapsing it into JSON null", async () => {
    const result = await reconcileJiraMapping({
      workspaceId: "ws-1", mappingId: "mapping-1", actor: "sync:user-1",
      baseline: { description: "Old" }, local: { description: "Old" }, remote: {},
    });
    expect(Object.prototype.hasOwnProperty.call(result.pulls, "description")).toBe(true);
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("jira_sync_operations") && params.targetJson === '{"$itestflow":"absent"}')).toBe(true);
  });

  it("does not automate over an unresolved mapping conflict", async () => {
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(reconcileJiraMapping({
      workspaceId: "ws-1", mappingId: "mapping-1", actor: "sync:user-1", baseline: {}, local: {}, remote: {},
    })).rejects.toThrow("not available");
    expect(String(mocks.sqlGet.mock.calls[0][0])).toContain("status = 'active'");
  });
});
