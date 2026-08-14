import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlAll: vi.fn(), sqlGet: vi.fn(), sqlRun: vi.fn(), audit: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-08-13T00:00:00.000Z", sqlAll: mocks.sqlAll, sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
  withTransaction: (work: (client: object) => unknown) => work({ transaction: true }),
}));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLogTransactional: mocks.audit }));

import { claimNextJiraSyncOperation, completeJiraSyncOperation, failJiraSyncOperation } from "./jira-sync-operation.service";

describe("completeJiraSyncOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlAll.mockReset().mockResolvedValue([]);
    mocks.sqlGet.mockReset();
    mocks.sqlRun.mockReset().mockResolvedValue(1);
  });

  it("advances the baseline only after the queued effect succeeds", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "op-1", mapping_id: "mapping-1", field_name: "title", target_json: '"New"', workspace_id: "ws-1", project_id: "project-1", jira_issue_key: "QA-7" })
      .mockResolvedValueOnce(undefined);
    await expect(completeJiraSyncOperation({ operationId: "op-1", actor: "system:worker" })).resolves.toEqual({ mappingStatus: "active" });
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("baseline_json = @targetJson") && params.targetJson === '"New"')).toBe(true);
    expect(mocks.sqlRun.mock.calls.some(([sql]) => String(sql).includes("last_synced_at = CASE"))).toBe(true);
  });

  it("claims one workspace-scoped operation with a skip-locked transition", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ id: "op-1", mapping_id: "mapping-1", field_name: "title", operation: "push", target_json: '"New"' });
    await expect(claimNextJiraSyncOperation("ws-1")).resolves.toEqual({ id: "op-1", mappingId: "mapping-1", field: "title", operation: "push", target: "New" });
    expect(String(mocks.sqlGet.mock.calls[0][0])).toContain("SKIP LOCKED");
    expect(mocks.sqlGet.mock.calls[0][1]).toMatchObject({ workspaceId: "ws-1", now: "2026-08-13T00:00:00.000Z" });
    expect(String(mocks.sqlRun.mock.calls[0][0])).toContain("processing_started_at < @staleCutoff");
  });

  it("restricts a worker claim to its trusted project when supplied", async () => {
    mocks.sqlGet.mockResolvedValue(null);
    await expect(claimNextJiraSyncOperation("ws-1", "project-1")).resolves.toBeNull();
    const candidate = mocks.sqlGet.mock.calls.find(([sql]) => String(sql).includes("SKIP LOCKED"));
    expect(candidate?.[0]).toContain("m.project_id = @projectId");
    expect(candidate?.[1]).toMatchObject({ workspaceId: "ws-1", projectId: "project-1" });
  });

  it("records a fixed failure code and moves the mapping to error", async () => {
    mocks.sqlGet.mockResolvedValue({ mapping_id: "mapping-1", attempts: 5 });
    await failJiraSyncOperation({ operationId: "op-1", errorCode: "integration_rate_limited" });
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("status = 'error'") && params.mappingId === "mapping-1")).toBe(true);
  });

  it("requeues transient failures with bounded backoff and a fixed error code", async () => {
    mocks.sqlGet.mockResolvedValue({ mapping_id: "mapping-1", attempts: 1 });
    await expect(failJiraSyncOperation({ operationId: "op-1", errorCode: "integration_rate_limited" }))
      .resolves.toEqual({ retry: true, runAfter: "2026-08-13T00:00:02.000Z" });
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => String(sql).includes("run_after") && params.status === "pending" && params.errorCode === "integration_rate_limited")).toBe(true);
    expect(mocks.sqlRun.mock.calls.some(([sql]) => String(sql).includes("status = 'error'"))).toBe(false);
  });

  it("terminalizes every stale fifth-attempt operation in the workspace", async () => {
    mocks.sqlAll.mockResolvedValue([
      { mapping_id: "mapping-1", field_name: "title" },
      { mapping_id: "mapping-2", field_name: "state" },
    ]);
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(claimNextJiraSyncOperation("ws-1")).resolves.toBeNull();
    const errorMappings = mocks.sqlRun.mock.calls
      .filter(([sql]) => String(sql).includes("jira_sync_mappings SET status = 'error'"))
      .map(([, params]) => params.mappingId);
    expect(errorMappings).toEqual(["mapping-1", "mapping-2"]);
  });
});
