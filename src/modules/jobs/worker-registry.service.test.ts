import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => db);

import {
  hasHealthyWorkerCapability,
  heartbeatWorkerInstance,
  registerWorkerInstance,
  removeStaleWorkerInstances,
  unregisterWorkerInstance,
} from "./worker-registry.service";

describe("worker registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.sqlRun.mockResolvedValue(1);
  });

  it("registers deterministic capabilities and an immediate heartbeat", async () => {
    await registerWorkerInstance({ id: "worker-1", capabilities: ["b", "a", "a"] });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO worker_instances"),
      { id: "worker-1", capabilitiesJson: JSON.stringify(["a", "b"]) },
    );
  });

  it("checks capability and freshness using database time", async () => {
    db.sqlGet.mockResolvedValue({ available: true });
    await expect(hasHealthyWorkerCapability("project_knowledge_v4", 20_000)).resolves.toBe(true);
    expect(db.sqlGet).toHaveBeenCalledWith(
      expect.stringContaining("capabilities_json ? @capability"),
      { capability: "project_knowledge_v4", healthyForMs: 20_000 },
    );
  });

  it("returns false when no capable worker is fresh", async () => {
    db.sqlGet.mockResolvedValue({ available: false });
    await expect(hasHealthyWorkerCapability("project_knowledge_v4")).resolves.toBe(false);
  });

  it("heartbeats, unregisters, and removes stale registrations", async () => {
    await expect(heartbeatWorkerInstance("worker-1")).resolves.toBe(true);
    await unregisterWorkerInstance("worker-1");
    await removeStaleWorkerInstances(60_000);
    expect(db.sqlRun).toHaveBeenCalledTimes(3);
  });
});
