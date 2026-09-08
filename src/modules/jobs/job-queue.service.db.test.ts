import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { describeDb } from "@/test/db";
import { getPool, resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  claimNextJob,
  completeJob,
  completeJobBatch,
  deferOwnedJob,
  enqueueJob,
  failJob,
  getRequestedJobCancellations,
  heartbeatJob,
  heartbeatJobs,
  loadCompletedJobBatch,
  requeueOwnedJobs,
} from "@/modules/jobs/job-queue.service";

const TYPE = "test_noop";
const WS = "ws_jobtest";

// DB-backed integration coverage; requires migrated PostgreSQL via DATABASE_URL.

describeDb("job queue (DB-backed)", () => {
  beforeAll(async () => {
    await sqlRun(
      `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
       VALUES (@id, 'Job Test', 'jobtest', 'https://dev.azure.com/jobtest', 'active', 't', 't')
       ON CONFLICT (id) DO NOTHING`,
      { id: WS },
    );
  });

  beforeEach(async () => {
    await sqlRun(`DELETE FROM jobs WHERE job_type = @t`, { t: TYPE });
  });

  afterEach(() => { vi.useRealTimers(); });

  it.each([undefined, "2030-01-01T00:00:01.000Z", "2030-01-01T00:01:00.000Z"])("uses the later of normal backoff and retry deadline %s", async (deadline) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS });
    await claimNextJob("owner", [TYPE]);
    await expect(failJob(id!, "safe failure", "owner", "integration_rate_limited", deadline)).resolves.toBe(true);
    expect(await sqlGet("SELECT status, attempts, run_after, locked_by FROM jobs WHERE id = @id", { id })).toEqual({
      status: "pending", attempts: 1, locked_by: null,
      run_after: deadline?.includes("00:01:") ? deadline : "2030-01-01T00:00:02.000Z",
    });
  });

  it("rejects malformed retry/defer deadlines without changing the owned job", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS });
    await claimNextJob("owner", [TYPE]);
    await expect(failJob(id!, "retry", "owner", null, "invalid")).rejects.toThrow(RangeError);
    await expect(deferOwnedJob(id!, "owner", "invalid")).rejects.toThrow(RangeError);
    expect(await sqlGet("SELECT status, attempts, locked_by FROM jobs WHERE id = @id", { id })).toEqual({ status: "running", attempts: 1, locked_by: "owner" });
  });

  it("keeps the existing five-minute exponential backoff cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, maxAttempts: 20 });
    await sqlRun("UPDATE jobs SET attempts = 9 WHERE id = @id", { id });
    await claimNextJob("owner", [TYPE]);
    await failJob(id!, "retry", "owner");
    expect(await sqlGet("SELECT attempts, run_after FROM jobs WHERE id = @id", { id })).toEqual({ attempts: 10, run_after: "2030-01-01T00:05:00.000Z" });
  });

  it("defers only the owned claim and preserves its identity, dedupe, diagnostics, and single-attempt budget", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, maxAttempts: 1, dedupeKey: "deferred", payload: { operationId: "operation" }, progress: { percent: 25 } });
    await sqlRun("UPDATE jobs SET error_message = 'earlier failure', error_code = 'integration_rate_limited' WHERE id = @id", { id });
    await claimNextJob("owner", [TYPE]);
    const deadline = "2030-01-01T00:01:00.000Z";
    await expect(deferOwnedJob(id!, "other", deadline)).resolves.toBe(false);
    expect(await sqlGet("SELECT status, attempts, locked_by FROM jobs WHERE id = @id", { id })).toEqual({ status: "running", attempts: 1, locked_by: "owner" });
    await expect(deferOwnedJob(id!, "owner", deadline)).resolves.toBe(true);
    const row = await sqlGet("SELECT id, status, attempts, run_after, locked_by, locked_at, finished_at, payload_json, progress_json, dedupe_key, error_message, error_code FROM jobs WHERE id = @id", { id });
    expect(row).toEqual({ id, status: "pending", attempts: 0, run_after: deadline, locked_by: null, locked_at: null, finished_at: null, payload_json: '{"operationId":"operation"}', progress_json: { percent: 25 }, dedupe_key: "deferred", error_message: "earlier failure", error_code: "integration_rate_limited" });
    await expect(deferOwnedJob(id!, "owner", deadline)).resolves.toBe(false);
    await expect(enqueueJob({ jobType: TYPE, workspaceId: WS, dedupeKey: "deferred" })).resolves.toBeNull();
  });

  it("lets a cancellation committed while deferral waits for the row lock win atomically", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, maxAttempts: 1 });
    await claimNextJob("owner", [TYPE]);
    const client = await getPool().connect();
    let deferred: Promise<boolean> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE jobs SET cancel_requested_at = $1 WHERE id = $2", [new Date().toISOString(), id]);
      deferred = deferOwnedJob(id!, "owner", "2030-01-01T00:01:00.000Z");
      // Observe PostgreSQL waiting on this transaction before committing cancellation.
      await expect.poll(async () => {
        const result = await client.query<{ blocked: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS blocked");
        return result.rows[0].blocked;
      }).toBe(true);
      await client.query("COMMIT");
      await expect(deferred).resolves.toBe(true);
      expect(await sqlGet("SELECT status, attempts, locked_by, locked_at, finished_at FROM jobs WHERE id = @id", { id })).toMatchObject({ status: "cancelled", attempts: 0, locked_by: null, locked_at: null, finished_at: expect.any(String) });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await deferred;
    }
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM jobs WHERE job_type = @t`, { t: TYPE });
    await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: WS });
    await resetDatabaseForTests();
  });

  it("enqueues, claims, and completes a job", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, payload: { n: 1 } });
    expect(id).toBeTruthy();

    const job = await claimNextJob("w1");
    expect(job?.id).toBe(id);
    expect(job?.status).toBe("running");
    expect(job?.attempts).toBe(1);

    await completeJob(id!, "w1");
    const row = await sqlGet<{ status: string }>(`SELECT status FROM jobs WHERE id = @id`, { id });
    expect(row?.status).toBe("completed");
  });

  it("claims only job types the worker advertises", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS });

    await expect(claimNextJob("wrong-capability", ["different_job_type"])).resolves.toBeNull();
    await expect(claimNextJob("capable", [TYPE])).resolves.toMatchObject({ id, jobType: TYPE });
  });

  it("never hands the same job to two workers (FOR UPDATE SKIP LOCKED)", async () => {
    const a = await enqueueJob({ jobType: TYPE, workspaceId: WS, payload: { k: "a" }, priority: 10 });
    const b = await enqueueJob({ jobType: TYPE, workspaceId: WS, payload: { k: "b" }, priority: 20 });

    // Hold a row lock on job A in a separate connection, simulating another worker.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [a]);
      // A concurrent claim must skip the locked A and pick B.
      const claimed = await claimNextJob("w2");
      expect(claimed?.id).toBe(b);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("retries with backoff, then fails after max attempts", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, maxAttempts: 2 });

    expect((await claimNextJob("w3"))?.id).toBe(id);
    await failJob(id!, "boom 1", "w3");

    const retried = await sqlGet<{ status: string; run_after: string; attempts: number }>(
      `SELECT status, run_after, attempts FROM jobs WHERE id = @id`,
      { id },
    );
    expect(retried?.status).toBe("pending");
    expect(retried?.attempts).toBe(1);
    expect(new Date(retried!.run_after).getTime()).toBeGreaterThan(Date.now()); // backoff is in the future
    expect(await claimNextJob("w3b")).toBeNull(); // not due yet

    // Force due, exhaust the last attempt.
    await sqlRun(`UPDATE jobs SET run_after = @now WHERE id = @id`, { now: new Date().toISOString(), id });
    expect((await claimNextJob("w3c"))?.attempts).toBe(2);
    await failJob(id!, "boom 2", "w3c");

    const failed = await sqlGet<{ status: string }>(`SELECT status FROM jobs WHERE id = @id`, { id });
    expect(failed?.status).toBe("failed");
  });

  it("dedupes active jobs by (workspace, type, dedupeKey)", async () => {
    const first = await enqueueJob({ jobType: TYPE, workspaceId: WS, dedupeKey: "k1" });
    const second = await enqueueJob({ jobType: TYPE, workspaceId: WS, dedupeKey: "k1" });
    expect(first).toBeTruthy();
    expect(second).toBeNull(); // skipped — an active job already exists
  });

  it("fences completion and failure to the worker that owns the lock", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS });
    expect((await claimNextJob("owner"))?.id).toBe(id);

    await expect(completeJob(id!, "other")).resolves.toBe(false);
    let row = await sqlGet<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM jobs WHERE id = @id`,
      { id },
    );
    expect(row).toMatchObject({ status: "running", locked_by: "owner" });

    await expect(failJob(id!, "wrong worker", "other")).resolves.toBe(false);
    row = await sqlGet<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM jobs WHERE id = @id`,
      { id },
    );
    expect(row).toMatchObject({ status: "running", locked_by: "owner" });

    await expect(completeJob(id!, "owner")).resolves.toBe(true);
    row = await sqlGet<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM jobs WHERE id = @id`,
      { id },
    );
    expect(row).toMatchObject({ status: "completed", locked_by: null });
  });

  it("requeues stale running jobs without reducing attempts", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, maxAttempts: 3 });
    const first = await claimNextJob("stale-worker");
    expect(first?.id).toBe(id);
    expect(first?.attempts).toBe(1);

    const staleLockedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await sqlRun(`UPDATE jobs SET locked_at = @lockedAt WHERE id = @id`, { id, lockedAt: staleLockedAt });

    const reclaimed = await claimNextJob("next-worker");
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.lockedBy).toBe("next-worker");
  });

  it("fails a stale running job once retries are exhausted instead of requeueing forever", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, maxAttempts: 1 });
    const claimed = await claimNextJob("doomed-worker");
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1); // already at max_attempts

    // Worker dies without heartbeating; its lock goes stale.
    const staleLockedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await sqlRun(`UPDATE jobs SET locked_at = @lockedAt WHERE id = @id`, { id, lockedAt: staleLockedAt });

    // The next claim cycle reaps it: exhausted -> failed, not requeued.
    expect(await claimNextJob("rescuer")).toBeNull();
    const row = await sqlGet<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM jobs WHERE id = @id`,
      { id },
    );
    expect(row).toMatchObject({ status: "failed", locked_by: null });
  });

  it("leaves a fresh (non-stale) running lock untouched", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS });
    expect((await claimNextJob("busy-worker"))?.id).toBe(id);

    // Another worker's claim cycle runs the reaper but must not touch a fresh lock.
    expect(await claimNextJob("intruder")).toBeNull();
    const row = await sqlGet<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM jobs WHERE id = @id`,
      { id },
    );
    expect(row).toMatchObject({ status: "running", locked_by: "busy-worker" });
  });

  it("heartbeats only the owning worker lock", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS });
    expect((await claimNextJob("heartbeat-owner"))?.id).toBe(id);

    await expect(heartbeatJob(id!, "other")).resolves.toBe(false);
    await expect(heartbeatJob(id!, "heartbeat-owner")).resolves.toBe(true);
  });

  it("heartbeats all of a worker's jobs in one batch, skipping foreign locks", async () => {
    const a = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 1 });
    const b = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 2 });
    const c = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 3 });
    expect((await claimNextJob("batch-owner"))?.id).toBe(a);
    expect((await claimNextJob("batch-owner"))?.id).toBe(b);
    expect((await claimNextJob("batch-other"))?.id).toBe(c);

    const backdated = new Date(Date.now() - 60 * 1000).toISOString();
    await sqlRun(`UPDATE jobs SET locked_at = @lockedAt WHERE id = ANY(@ids)`, { lockedAt: backdated, ids: [a, b, c] });

    const refreshed = await heartbeatJobs([a!, b!, c!], "batch-owner");
    expect(refreshed.sort()).toEqual([a, b].sort());

    const rows = await Promise.all([a, b, c].map((id) =>
      sqlGet<{ locked_at: string }>(`SELECT locked_at FROM jobs WHERE id = @id`, { id }),
    ));
    expect(new Date(rows[0]!.locked_at).getTime()).toBeGreaterThan(new Date(backdated).getTime());
    expect(new Date(rows[1]!.locked_at).getTime()).toBeGreaterThan(new Date(backdated).getTime());
    expect(rows[2]!.locked_at).toBe(backdated); // foreign lock untouched
  });

  it("returns only owned running jobs with a pending cancellation request", async () => {
    const a = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 1 });
    const b = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 2 });
    const c = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 3 });
    expect((await claimNextJob("cancel-owner"))?.id).toBe(a);
    expect((await claimNextJob("cancel-owner"))?.id).toBe(b);
    expect((await claimNextJob("cancel-other"))?.id).toBe(c);

    const now = new Date().toISOString();
    await sqlRun(`UPDATE jobs SET cancel_requested_at = @now WHERE id = ANY(@ids)`, { now, ids: [a, c] });

    // Only the owned + flagged job comes back; the foreign flagged job does not.
    await expect(getRequestedJobCancellations([a!, b!, c!], "cancel-owner")).resolves.toEqual([a]);
  });

  it("requeues owned running jobs without consuming a retry", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, maxAttempts: 3 });
    expect((await claimNextJob("drain-worker"))?.attempts).toBe(1);
    await sqlRun(`UPDATE jobs SET error_message = 'earlier transient failure' WHERE id = @id`, { id });

    await expect(requeueOwnedJobs([id!], "drain-worker")).resolves.toBe(1);
    const row = await sqlGet<{
      status: string; attempts: number; locked_by: string | null; locked_at: string | null;
      run_after: string; error_message: string | null;
    }>(`SELECT status, attempts, locked_by, locked_at, run_after, error_message FROM jobs WHERE id = @id`, { id });
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0, // the claim's increment was refunded
      locked_by: null,
      locked_at: null,
      error_message: "earlier transient failure",
    });
    expect(new Date(row!.run_after).getTime()).toBeLessThanOrEqual(Date.now());

    // Immediately claimable again, back on its first attempt.
    expect((await claimNextJob("successor"))?.attempts).toBe(1);
  });

  it("requeue only touches the calling worker's running jobs", async () => {
    const a = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 1 });
    const b = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 2 });
    const c = await enqueueJob({ jobType: TYPE, workspaceId: WS, priority: 3 });
    expect((await claimNextJob("requeue-owner"))?.id).toBe(a);
    expect((await claimNextJob("requeue-owner"))?.id).toBe(b);
    expect((await claimNextJob("requeue-other"))?.id).toBe(c);
    await completeJob(b!, "requeue-owner");

    await expect(requeueOwnedJobs([a!, b!, c!], "requeue-owner")).resolves.toBe(1);
    const statuses = await Promise.all([a, b, c].map((id) =>
      sqlGet<{ status: string; locked_by: string | null }>(`SELECT status, locked_by FROM jobs WHERE id = @id`, { id }),
    ));
    expect(statuses[0]).toMatchObject({ status: "pending", locked_by: null });
    expect(statuses[1]).toMatchObject({ status: "completed", locked_by: null });
    expect(statuses[2]).toMatchObject({ status: "running", locked_by: "requeue-other" });
  });

  it("a requeued job keeps its active dedupe slot", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS, dedupeKey: "requeue-dedupe" });
    expect((await claimNextJob("dedupe-worker"))?.id).toBe(id);
    await expect(requeueOwnedJobs([id!], "dedupe-worker")).resolves.toBe(1);

    await expect(enqueueJob({ jobType: TYPE, workspaceId: WS, dedupeKey: "requeue-dedupe" })).resolves.toBeNull();
  });

  it("fences batch-cache reads and writes to the worker that owns the job", async () => {
    const id = await enqueueJob({ jobType: TYPE, workspaceId: WS });
    expect((await claimNextJob("cache-owner"))?.id).toBe(id);

    // A non-owner cannot seed the cache.
    await expect(completeJobBatch({ jobId: id!, batchKey: "extraction:0", result: { v: 1 }, workerId: "cache-other" }))
      .resolves.toBe(false);
    await expect(sqlGet(`SELECT id FROM project_knowledge_job_batches WHERE job_id = @id`, { id })).resolves.toBeUndefined();

    // The owner writes, re-writes (upsert), and reads; a non-owner reads a miss.
    await expect(completeJobBatch({ jobId: id!, batchKey: "extraction:0", result: { v: 1 }, workerId: "cache-owner" }))
      .resolves.toBe(true);
    await expect(loadCompletedJobBatch(id!, "extraction:0", "cache-owner")).resolves.toEqual({ v: 1 });
    await expect(loadCompletedJobBatch(id!, "extraction:0", "cache-other")).resolves.toBeNull();
    await expect(completeJobBatch({ jobId: id!, batchKey: "extraction:0", result: { v: 2 }, workerId: "cache-owner" }))
      .resolves.toBe(true);
    await expect(loadCompletedJobBatch(id!, "extraction:0", "cache-owner")).resolves.toEqual({ v: 2 });

    // After a shutdown requeue the job is no longer running, so even the old
    // owner is fenced out of its cache until the job is claimed again.
    await expect(requeueOwnedJobs([id!], "cache-owner")).resolves.toBe(1);
    await expect(loadCompletedJobBatch(id!, "extraction:0", "cache-owner")).resolves.toBeNull();
    await expect(completeJobBatch({ jobId: id!, batchKey: "extraction:1", result: { v: 3 }, workerId: "cache-owner" }))
      .resolves.toBe(false);
  });
});
