import { afterAll, beforeEach, expect, it } from "vitest";

import { resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { describeDb } from "@/test/db";
import {
  hasHealthyWorkerCapability,
  heartbeatWorkerInstance,
  registerWorkerInstance,
  unregisterWorkerInstance,
} from "./worker-registry.service";

const WORKER_ID = "worker-registry-integration";
const CAPABILITY = `worker-registry-test-${WORKER_ID}`;

describeDb("worker registry (DB-backed)", () => {
  beforeEach(async () => {
    await sqlRun(`DELETE FROM worker_instances WHERE id = @id`, { id: WORKER_ID });
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM worker_instances WHERE id = @id`, { id: WORKER_ID });
    await resetDatabaseForTests();
  });

  it("registers capabilities, heartbeats, and expires stale workers using database time", async () => {
    await registerWorkerInstance({ id: WORKER_ID, capabilities: [CAPABILITY] });
    await expect(hasHealthyWorkerCapability(CAPABILITY)).resolves.toBe(true);
    await expect(heartbeatWorkerInstance(WORKER_ID)).resolves.toBe(true);

    await sqlRun(
      `UPDATE worker_instances SET heartbeat_at = NOW() - INTERVAL '1 minute' WHERE id = @id`,
      { id: WORKER_ID },
    );
    await expect(hasHealthyWorkerCapability(CAPABILITY)).resolves.toBe(false);

    await unregisterWorkerInstance(WORKER_ID);
    await expect(hasHealthyWorkerCapability(CAPABILITY)).resolves.toBe(false);
  });
});
