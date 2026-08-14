import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "link-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
  withTransaction: (work: (client: object) => unknown) => work({ tx: true }),
}));
vi.mock("./zephyr-scale-config.service", () => ({
  resolveZephyrScaleConfigRow: vi.fn(() => ({ apiToken: "token", region: "us", jiraProjectKey: "QA", localIdFieldName: "iTestFlow ID" })),
}));
import { publishZephyrExecution } from "./zephyr-execution-publishing.service";

describe("publishZephyrExecution", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.sqlRun.mockResolvedValue(0); });
  const input = { workspaceId: "ws-1", projectId: "project-1", actorUserId: "user-1", localExecutionId: "execution-local-1", testCaseKey: "QA-T1", testCycleKey: "QA-R1", statusName: "Pass" };

  it("returns an authorized stable link without touching Zephyr", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce({ remote_artifact_id: "QA-E1" });
    const backend = { reconcileExecution: vi.fn() };
    const createBackend = vi.fn().mockReturnValue(backend);
    await expect(publishZephyrExecution({ ...input, createBackend })).resolves.toEqual({ remoteId: "QA-E1", created: false });
    expect(createBackend).not.toHaveBeenCalled();
    expect(backend.reconcileExecution).not.toHaveBeenCalled();
  });

  it("claims the immutable identity before Zephyr and activates only its own claim", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: "link-1" }).mockResolvedValueOnce({ remote_artifact_id: "QA-E1" });
    const backend = { reconcileExecution: vi.fn().mockResolvedValue("QA-E1") };
    const createBackend = vi.fn().mockReturnValue(backend);
    await expect(publishZephyrExecution({ ...input, createBackend, stepResults: [] })).resolves.toEqual({ remoteId: "QA-E1", created: true });
    expect(createBackend.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.sqlGet.mock.invocationCallOrder[2]);
    expect(mocks.sqlGet.mock.calls[2][0]).toContain("ON CONFLICT (workspace_id, project_id, local_artifact_type, local_artifact_id)");
    expect(mocks.sqlGet.mock.calls[2][0]).toContain("id = excluded.id");
    expect(mocks.sqlGet.mock.calls[2][0]).toContain("status IN ('error', 'missing_remote')");
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("JOIN workspace_members");
    expect(mocks.sqlGet.mock.calls[0][2]).toEqual({ tx: true });
    expect(backend.reconcileExecution).toHaveBeenCalledWith({ projectId: "QA", testCaseKey: "QA-T1", testCycleKey: "QA-R1", statusName: "Pass", stepResults: [] });
    expect(mocks.sqlGet.mock.calls[3][1]).toMatchObject({ id: "link-1", remoteId: "QA-E1" });
    expect(mocks.sqlGet.mock.calls[3][0]).toContain("WHERE l.id = @id");
    expect(mocks.sqlGet.mock.calls[3][0]).toContain("c.backend_type = 'zephyr_scale'");
  });

  it("rejects a concurrent publisher when the durable claim is held", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const backend = { reconcileExecution: vi.fn() };
    await expect(publishZephyrExecution({ ...input, createBackend: vi.fn().mockReturnValue(backend) })).rejects.toThrow("already being published");
    expect(backend.reconcileExecution).not.toHaveBeenCalled();
  });

  it("retires its owned claim when Zephyr fails", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: "link-1" });
    const backend = { reconcileExecution: vi.fn().mockRejectedValue(new Error("remote failed")) };

    await expect(publishZephyrExecution({ ...input, createBackend: vi.fn().mockReturnValue(backend) })).rejects.toThrow("remote failed");

    const failureWrite = mocks.sqlRun.mock.calls.find(([sql]) => String(sql).includes("WHERE id = @id"));
    expect(failureWrite?.[0]).toContain("status = 'error'");
    expect(failureWrite?.[1]).toMatchObject({ id: "link-1" });
  });

  it("retires its owned claim when post-claim backend construction fails", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: "link-1" });

    await expect(publishZephyrExecution({
      ...input,
      createBackend: vi.fn(() => { throw new Error("backend construction failed"); }),
    })).rejects.toThrow("backend construction failed");

    const failureWrite = mocks.sqlRun.mock.calls.find(([sql]) => String(sql).includes("WHERE id = @id"));
    expect(failureWrite?.[0]).toContain("status = 'error'");
    expect(failureWrite?.[1]).toMatchObject({ id: "link-1" });
  });
});
