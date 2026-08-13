import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ createId: () => "link-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet }));
import { publishZephyrExecution } from "./zephyr-execution-publishing.service";

describe("publishZephyrExecution", () => {
  beforeEach(() => vi.clearAllMocks());
  const input = { workspaceId: "ws-1", projectId: "project-1", actorUserId: "user-1", localExecutionId: "execution-local-1", testCaseKey: "QA-T1", testCycleKey: "QA-R1", statusName: "Pass" };

  it("returns an authorized stable link without touching Zephyr", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce({ remote_artifact_id: "QA-E1" });
    const backend = { reconcileExecution: vi.fn() };
    await expect(publishZephyrExecution({ ...input, backend })).resolves.toEqual({ remoteId: "QA-E1", created: false });
    expect(backend.reconcileExecution).not.toHaveBeenCalled();
  });

  it("claims the immutable identity before Zephyr and activates only its own claim", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: "link-1" }).mockResolvedValueOnce({ remote_artifact_id: "QA-E1" });
    const backend = { reconcileExecution: vi.fn().mockResolvedValue("QA-E1") };
    await expect(publishZephyrExecution({ ...input, backend, stepResults: [] })).resolves.toEqual({ remoteId: "QA-E1", created: true });
    expect(mocks.sqlGet.mock.calls[2][0]).toContain("ON CONFLICT (workspace_id, project_id, local_artifact_type, local_artifact_id)");
    expect(mocks.sqlGet.mock.calls[2][0]).toContain("id = excluded.id");
    expect(mocks.sqlGet.mock.calls[2][0]).toContain("JOIN workspace_members");
    expect(backend.reconcileExecution).toHaveBeenCalledWith({ projectId: "QA", testCaseKey: "QA-T1", testCycleKey: "QA-R1", statusName: "Pass", stepResults: [] });
    expect(mocks.sqlGet.mock.calls[3][1]).toMatchObject({ id: "link-1", remoteId: "QA-E1" });
    expect(mocks.sqlGet.mock.calls[3][0]).toContain("WHERE id = @id");
  });

  it("rejects a concurrent publisher when the durable claim is held", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ provider_project_key: "QA" }).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const backend = { reconcileExecution: vi.fn() };
    await expect(publishZephyrExecution({ ...input, backend })).rejects.toThrow("already being published");
    expect(backend.reconcileExecution).not.toHaveBeenCalled();
  });
});
