import { beforeEach, describe, expect, it, vi } from "vitest";

const jobQueue = vi.hoisted(() => ({
  claimNextJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  heartbeatJob: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  getJobHandler: vi.fn(),
  registeredJobTypes: vi.fn(() => []),
}));
const registration = vi.hoisted(() => ({ registerAllJobHandlers: vi.fn() }));
const schedule = vi.hoisted(() => ({ enqueueDueScheduledSyncs: vi.fn() }));

// main.ts reads the heartbeat cadence from env at module load; pin it before import.
const HEARTBEAT_MS = vi.hoisted(() => {
  process.env.WORKER_HEARTBEAT_MS = "1000";
  return 1000;
});

vi.mock("@/modules/jobs/job-queue.service", () => jobQueue);
vi.mock("@/modules/jobs/job-handlers", () => registry);
vi.mock("@/modules/jobs/register-handlers", () => registration);
vi.mock("@/modules/jobs/sync-schedule.service", () => schedule);

import type { Job } from "@/modules/jobs/job-queue.service";
import { processNextJob } from "./main";

// Ownership token the worker passes to every queue mutation.
const WORKER_ID = `worker-${process.pid}`;

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    workspaceId: "ws-1",
    jobType: "workspace_context_sync",
    payload: { projectId: "proj-1" },
    dedupeKey: null,
    status: "running",
    priority: 100,
    attempts: 1,
    maxAttempts: 3,
    lockedBy: WORKER_ID,
    lockedAt: "2026-07-06T00:00:00.000Z",
    runAfter: "2026-07-06T00:00:00.000Z",
    errorMessage: null,
    createdByUserId: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("processNextJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The dispatch loop logs every outcome; keep test output clean.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    jobQueue.completeJob.mockResolvedValue(true);
    jobQueue.failJob.mockResolvedValue(true);
    jobQueue.heartbeatJob.mockResolvedValue(true);
  });

  it("importing the module does not start the worker loops", () => {
    // The auto-start is guarded on being the process entrypoint; under vitest the
    // entrypoint is the test runner, so nothing may have been claimed or registered.
    expect(jobQueue.claimNextJob).not.toHaveBeenCalled();
    expect(registration.registerAllJobHandlers).not.toHaveBeenCalled();
  });

  it("reports idle without touching job state when no job is claimed", async () => {
    jobQueue.claimNextJob.mockResolvedValue(null);
    await expect(processNextJob()).resolves.toBe(false);
    expect(jobQueue.claimNextJob).toHaveBeenCalledWith(WORKER_ID);
    expect(registry.getJobHandler).not.toHaveBeenCalled();
    expect(jobQueue.failJob).not.toHaveBeenCalled();
    expect(jobQueue.completeJob).not.toHaveBeenCalled();
    expect(jobQueue.heartbeatJob).not.toHaveBeenCalled();
  });

  it("fails a job with no registered handler and still reports it processed", async () => {
    vi.useFakeTimers();
    registry.getJobHandler.mockReturnValue(undefined);
    jobQueue.claimNextJob.mockResolvedValue(makeJob({ jobType: "mystery" }));
    // true = "processed": the work loop drains back-to-back instead of idle-sleeping.
    await expect(processNextJob()).resolves.toBe(true);
    expect(jobQueue.failJob).toHaveBeenCalledWith(
      "job-1",
      'No handler registered for job type "mystery".',
      WORKER_ID,
    );
    expect(jobQueue.completeJob).not.toHaveBeenCalled();
    // No heartbeat interval is ever installed on this path.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(jobQueue.heartbeatJob).not.toHaveBeenCalled();
  });

  it("heartbeats while the handler runs, then completes the job and stops heartbeating", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const handler = vi.fn(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    registry.getJobHandler.mockReturnValue(handler);
    jobQueue.claimNextJob.mockResolvedValue(makeJob());

    const running = processNextJob();
    // Flush the claim so the heartbeat interval is installed, then cross two periods.
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(jobQueue.heartbeatJob).toHaveBeenCalledTimes(2);
    expect(jobQueue.heartbeatJob).toHaveBeenCalledWith("job-1", WORKER_ID);
    // Nothing is finalized while the handler is still running.
    expect(jobQueue.completeJob).not.toHaveBeenCalled();
    expect(jobQueue.failJob).not.toHaveBeenCalled();

    finish();
    await expect(running).resolves.toBe(true);
    expect(jobQueue.completeJob).toHaveBeenCalledWith("job-1", WORKER_ID);
    expect(jobQueue.failJob).not.toHaveBeenCalled();

    // Completion clears the interval: no further heartbeats fire.
    jobQueue.heartbeatJob.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(jobQueue.heartbeatJob).not.toHaveBeenCalled();
  });

  it("fails the job with the handler's error message and clears its heartbeat interval", async () => {
    vi.useFakeTimers();
    registry.getJobHandler.mockReturnValue(vi.fn().mockRejectedValue(new Error("boom")));
    jobQueue.claimNextJob.mockResolvedValue(makeJob());

    await expect(processNextJob()).resolves.toBe(true);
    expect(jobQueue.failJob).toHaveBeenCalledWith("job-1", "boom", WORKER_ID);
    expect(jobQueue.completeJob).not.toHaveBeenCalled();

    // The finally block cleared the interval: advancing well past the cadence fires nothing.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5);
    expect(jobQueue.heartbeatJob).not.toHaveBeenCalled();
  });

  it("maps a non-Error throw to the generic failure message", async () => {
    registry.getJobHandler.mockReturnValue(vi.fn().mockRejectedValue("string reason"));
    jobQueue.claimNextJob.mockResolvedValue(makeJob());
    await expect(processNextJob()).resolves.toBe(true);
    expect(jobQueue.failJob).toHaveBeenCalledWith("job-1", "Job handler failed.", WORKER_ID);
  });
});
