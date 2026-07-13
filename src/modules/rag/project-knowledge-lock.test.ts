import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlGet = vi.hoisted(() => vi.fn());
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ sqlGet }));

import { acquireProjectKnowledgeLock, projectKnowledgeLockKey } from "./project-knowledge-lock";

describe("project knowledge advisory lock", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses one stable identity for sync and publication in a project", async () => {
    const scope = { projectId: "project-1", azureProjectId: "azure-1" };
    expect(projectKnowledgeLockKey(scope)).toBe("itestflow:project-knowledge:project-1:azure-1");
    expect(projectKnowledgeLockKey(scope)).not.toBe(projectKnowledgeLockKey({ ...scope, azureProjectId: "azure-2" }));
    const client = {} as never;
    await acquireProjectKnowledgeLock(scope, client);
    expect(sqlGet).toHaveBeenCalledExactlyOnceWith(
      "SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 0)) AS acquired",
      { lockKey: "itestflow:project-knowledge:project-1:azure-1" },
      client,
    );
  });
});
