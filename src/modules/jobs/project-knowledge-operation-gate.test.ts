import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ release: vi.fn() }));
const db = vi.hoisted(() => ({ getPool: vi.fn(), sqlGet: vi.fn() }));
const queue = vi.hoisted(() => ({ findActiveJob: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => db);
vi.mock("./job-queue.service", () => queue);

import { AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  assertNoActiveProjectKnowledgeBuild,
  withProjectKnowledgeOperationGate,
} from "./project-knowledge-operation-gate";

const scope = { workspaceId: "workspace-1", projectId: "project-1", azureProjectId: "azure-1" };

describe("project knowledge operation gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });
    db.sqlGet.mockResolvedValue({ acquired: true });
    queue.findActiveJob.mockResolvedValue(null);
  });

  it("holds and releases a project-scoped advisory gate around a synchronous action", async () => {
    const action = vi.fn().mockResolvedValue("done");
    await expect(withProjectKnowledgeOperationGate(scope, "publish", action)).resolves.toBe("done");
    expect(action).toHaveBeenCalledOnce();
    expect(db.sqlGet.mock.calls[0][0]).toContain("pg_try_advisory_lock");
    expect(db.sqlGet.mock.calls[1][0]).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects instead of waiting when another synchronous operation owns the gate", async () => {
    db.sqlGet.mockResolvedValueOnce({ acquired: false });
    const action = vi.fn();
    await expect(withProjectKnowledgeOperationGate(scope, "build", action))
      .rejects.toMatchObject({ code: AppErrorCode.KnowledgeDraftConflict });
    expect(action).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects synchronous work while a build is pending or running", async () => {
    queue.findActiveJob.mockResolvedValue({ id: "job-1", status: "running" });
    await expect(assertNoActiveProjectKnowledgeBuild(scope))
      .rejects.toMatchObject({ code: AppErrorCode.KnowledgeDraftConflict });
  });
});
