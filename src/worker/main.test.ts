import { beforeEach, describe, expect, it, vi } from "vitest";

const jobQueue = vi.hoisted(() => ({
  cancelRunningJob: vi.fn(),
  claimNextJob: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  getRequestedJobCancellations: vi.fn(),
  heartbeatJob: vi.fn(),
  heartbeatJobs: vi.fn(),
  isJobCancellationRequested: vi.fn(),
  requeueOwnedJobs: vi.fn(),
  updateJobProgress: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  getJobHandler: vi.fn(),
  registeredJobTypes: vi.fn((): string[] => []),
}));
const registration = vi.hoisted(() => ({ registerAllJobHandlers: vi.fn() }));
const schedule = vi.hoisted(() => ({ enqueueDueScheduledSyncs: vi.fn() }));
const workerRegistry = vi.hoisted(() => ({
  heartbeatWorkerInstance: vi.fn(),
  registerWorkerInstance: vi.fn(),
  removeStaleWorkerInstances: vi.fn(),
  unregisterWorkerInstance: vi.fn(),
  WORKER_REGISTRY_HEARTBEAT_MS: 5000,
}));

// main.ts reads the heartbeat cadence from env at module load; pin it before import.
const HEARTBEAT_MS = vi.hoisted(() => {
  process.env.WORKER_HEARTBEAT_MS = "1000";
  return 1000;
});
const CANCELLATION_POLL_MS = 1000;
const KNOWLEDGE_TYPE = "project_knowledge_v4";

vi.mock("@/modules/jobs/job-queue.service", () => jobQueue);
vi.mock("@/modules/jobs/job-handlers", () => registry);
vi.mock("@/modules/jobs/project-knowledge-jobs.service", () => ({ PROJECT_KNOWLEDGE_JOB: "project_knowledge_v4" }));
vi.mock("@/modules/jobs/register-handlers", () => registration);
vi.mock("@/modules/jobs/sync-schedule.service", () => schedule);
vi.mock("@/modules/jobs/worker-registry.service", () => workerRegistry);

import type { Job } from "@/modules/jobs/job-queue.service";
import {
  attachSupervisorShutdownChannel,
  dispatchReadyKnowledgeJobs,
  processNextJob,
  requeueUnfinishedJobsForShutdown,
  waitForActiveJobs,
  WORKER_ID,
  WORKER_SHUTDOWN_MESSAGE,
} from "./main";

// Ownership token the worker passes to every queue mutation.

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

/**
 * A handler that stays running until the test resolves it by job id, and that
 * honors its AbortSignal the way real handlers do (reject with the reason).
 */
function deferredHandler() {
  const finishers = new Map<string, () => void>();
  const handler = vi.fn((job: Job, context: { signal: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      finishers.set(job.id, () => resolve());
    }),
  );
  return { handler, finish: (id: string) => finishers.get(id)?.() };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The dispatch loop logs every outcome; keep test output clean.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  jobQueue.completeJob.mockResolvedValue(true);
  jobQueue.cancelRunningJob.mockResolvedValue(true);
  jobQueue.failJob.mockResolvedValue(true);
  jobQueue.getRequestedJobCancellations.mockResolvedValue([]);
  jobQueue.heartbeatJob.mockResolvedValue(true);
  jobQueue.heartbeatJobs.mockImplementation(async (ids: string[]) => ids);
  jobQueue.isJobCancellationRequested.mockResolvedValue(false);
  jobQueue.requeueOwnedJobs.mockResolvedValue(0);
  jobQueue.updateJobProgress.mockResolvedValue(true);
  registry.registeredJobTypes.mockReturnValue(["workspace_context_sync"]);
});

describe("processNextJob (serial lane)", () => {
  it("importing the module does not start the worker loops", () => {
    // The auto-start is guarded on being the process entrypoint; under vitest the
    // entrypoint is the test runner, so nothing may have been claimed or registered.
    expect(jobQueue.claimNextJob).not.toHaveBeenCalled();
    expect(registration.registerAllJobHandlers).not.toHaveBeenCalled();
  });

  it("reports idle without touching job state when no job is claimed", async () => {
    jobQueue.claimNextJob.mockResolvedValue(null);
    await expect(processNextJob()).resolves.toBe(false);
    expect(jobQueue.claimNextJob).toHaveBeenCalledWith(WORKER_ID, ["workspace_context_sync"]);
    expect(registry.getJobHandler).not.toHaveBeenCalled();
    expect(jobQueue.failJob).not.toHaveBeenCalled();
    expect(jobQueue.completeJob).not.toHaveBeenCalled();
    expect(jobQueue.heartbeatJobs).not.toHaveBeenCalled();
  });

  it("never claims knowledge jobs even when the handler is registered", async () => {
    registry.registeredJobTypes.mockReturnValue(["workspace_context_sync", KNOWLEDGE_TYPE]);
    jobQueue.claimNextJob.mockResolvedValue(null);
    await expect(processNextJob()).resolves.toBe(false);
    expect(jobQueue.claimNextJob).toHaveBeenCalledWith(WORKER_ID, ["workspace_context_sync"]);
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
    expect(jobQueue.heartbeatJobs).not.toHaveBeenCalled();
  });

  it("heartbeats while the handler runs, then completes the job and stops heartbeating", async () => {
    vi.useFakeTimers();
    const { handler, finish } = deferredHandler();
    registry.getJobHandler.mockReturnValue(handler);
    jobQueue.claimNextJob.mockResolvedValue(makeJob());

    const running = processNextJob();
    // Flush the claim so the heartbeat interval is installed, then cross two periods.
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(jobQueue.heartbeatJobs).toHaveBeenCalledTimes(2);
    expect(jobQueue.heartbeatJobs).toHaveBeenCalledWith(["job-1"], WORKER_ID);
    // Nothing is finalized while the handler is still running.
    expect(jobQueue.completeJob).not.toHaveBeenCalled();
    expect(jobQueue.failJob).not.toHaveBeenCalled();

    finish("job-1");
    await expect(running).resolves.toBe(true);
    expect(jobQueue.completeJob).toHaveBeenCalledWith("job-1", WORKER_ID, null);
    expect(jobQueue.failJob).not.toHaveBeenCalled();

    // Completion clears the interval: no further heartbeats fire.
    jobQueue.heartbeatJobs.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(jobQueue.heartbeatJobs).not.toHaveBeenCalled();
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
    expect(jobQueue.heartbeatJobs).not.toHaveBeenCalled();
  });

  it("maps a non-Error throw to the generic failure message", async () => {
    registry.getJobHandler.mockReturnValue(vi.fn().mockRejectedValue("string reason"));
    jobQueue.claimNextJob.mockResolvedValue(makeJob());
    await expect(processNextJob()).resolves.toBe(true);
    expect(jobQueue.failJob).toHaveBeenCalledWith("job-1", "Job handler failed.", WORKER_ID);
  });
});

describe("dispatchReadyKnowledgeJobs", () => {
  function knowledgeJob(id: string): Job {
    return makeJob({ id, jobType: KNOWLEDGE_TYPE, dedupeKey: `project_knowledge:${id}` });
  }

  it("drains every ready job, reaping stale locks only on the first claim", async () => {
    const { handler, finish } = deferredHandler();
    registry.getJobHandler.mockReturnValue(handler);
    jobQueue.claimNextJob
      .mockResolvedValueOnce(knowledgeJob("job-a"))
      .mockResolvedValueOnce(knowledgeJob("job-b"))
      .mockResolvedValue(null);

    await expect(dispatchReadyKnowledgeJobs()).resolves.toBe(2);
    expect(jobQueue.claimNextJob).toHaveBeenCalledTimes(3);
    expect(jobQueue.claimNextJob).toHaveBeenNthCalledWith(1, WORKER_ID, [KNOWLEDGE_TYPE], { reapStale: true });
    expect(jobQueue.claimNextJob).toHaveBeenNthCalledWith(2, WORKER_ID, [KNOWLEDGE_TYPE], { reapStale: false });
    expect(jobQueue.claimNextJob).toHaveBeenNthCalledWith(3, WORKER_ID, [KNOWLEDGE_TYPE], { reapStale: false });

    // Both handlers started before either finished: the builds run concurrently.
    expect(handler).toHaveBeenCalledTimes(2);
    expect(jobQueue.completeJob).not.toHaveBeenCalled();

    finish("job-a");
    finish("job-b");
    await expect(waitForActiveJobs(1000)).resolves.toBe(true);
    expect(jobQueue.completeJob).toHaveBeenCalledWith("job-a", WORKER_ID, null);
    expect(jobQueue.completeJob).toHaveBeenCalledWith("job-b", WORKER_ID, null);
  });

  it("covers all active jobs with one batched heartbeat that shrinks as builds finish", async () => {
    vi.useFakeTimers();
    const { handler, finish } = deferredHandler();
    registry.getJobHandler.mockReturnValue(handler);
    jobQueue.claimNextJob
      .mockResolvedValueOnce(knowledgeJob("job-a"))
      .mockResolvedValueOnce(knowledgeJob("job-b"))
      .mockResolvedValue(null);

    await dispatchReadyKnowledgeJobs();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(jobQueue.heartbeatJobs).toHaveBeenCalledTimes(1);
    expect(jobQueue.heartbeatJobs).toHaveBeenCalledWith(["job-a", "job-b"], WORKER_ID);

    finish("job-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(jobQueue.completeJob).toHaveBeenCalledWith("job-a", WORKER_ID, null);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(jobQueue.heartbeatJobs).toHaveBeenLastCalledWith(["job-b"], WORKER_ID);

    finish("job-b");
    await vi.advanceTimersByTimeAsync(0);
    jobQueue.heartbeatJobs.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(jobQueue.heartbeatJobs).not.toHaveBeenCalled();
  });

  it("aborts only the job whose cancellation was requested; siblings keep running", async () => {
    vi.useFakeTimers();
    const { handler, finish } = deferredHandler();
    registry.getJobHandler.mockReturnValue(handler);
    jobQueue.claimNextJob
      .mockResolvedValueOnce(knowledgeJob("job-a"))
      .mockResolvedValueOnce(knowledgeJob("job-b"))
      .mockResolvedValue(null);

    await dispatchReadyKnowledgeJobs();
    jobQueue.getRequestedJobCancellations.mockResolvedValue(["job-a"]);
    await vi.advanceTimersByTimeAsync(CANCELLATION_POLL_MS);

    expect(jobQueue.cancelRunningJob).toHaveBeenCalledWith("job-a", WORKER_ID);
    expect(jobQueue.completeJob).not.toHaveBeenCalled();
    expect(jobQueue.failJob).not.toHaveBeenCalled();

    jobQueue.getRequestedJobCancellations.mockResolvedValue([]);
    finish("job-b");
    await vi.advanceTimersByTimeAsync(0);
    expect(jobQueue.completeJob).toHaveBeenCalledWith("job-b", WORKER_ID, null);
    expect(jobQueue.cancelRunningJob).toHaveBeenCalledTimes(1);
  });

  it("isolates one build's failure from its concurrently running siblings", async () => {
    const { handler, finish } = deferredHandler();
    registry.getJobHandler.mockImplementation(() => (job: Job, context: { signal: AbortSignal }) =>
      job.id === "job-a"
        ? Promise.reject(new Error("extraction exploded"))
        : handler(job, context),
    );
    jobQueue.claimNextJob
      .mockResolvedValueOnce(knowledgeJob("job-a"))
      .mockResolvedValueOnce(knowledgeJob("job-b"))
      .mockResolvedValue(null);

    await dispatchReadyKnowledgeJobs();
    finish("job-b");
    await expect(waitForActiveJobs(1000)).resolves.toBe(true);

    expect(jobQueue.failJob).toHaveBeenCalledWith("job-a", "extraction exploded", WORKER_ID);
    expect(jobQueue.completeJob).toHaveBeenCalledWith("job-b", WORKER_ID, null);
    expect(jobQueue.completeJob).not.toHaveBeenCalledWith("job-a", expect.anything(), expect.anything());
  });
});

describe("shutdown", () => {
  it("requeues unfinished jobs without cancelling, failing, or completing them", async () => {
    const { handler } = deferredHandler();
    registry.getJobHandler.mockReturnValue(handler);
    jobQueue.claimNextJob
      .mockResolvedValueOnce(makeJob({ id: "job-a", jobType: KNOWLEDGE_TYPE }))
      .mockResolvedValue(null);
    jobQueue.requeueOwnedJobs.mockResolvedValue(1);

    await dispatchReadyKnowledgeJobs();
    await expect(requeueUnfinishedJobsForShutdown()).resolves.toBe(1);
    expect(jobQueue.requeueOwnedJobs).toHaveBeenCalledWith(["job-a"], WORKER_ID);

    // The aborted handler unwinds without touching the row: the fenced requeue
    // already decided the job's fate.
    await expect(waitForActiveJobs(1000)).resolves.toBe(true);
    expect(jobQueue.cancelRunningJob).not.toHaveBeenCalled();
    expect(jobQueue.failJob).not.toHaveBeenCalled();
    expect(jobQueue.completeJob).not.toHaveBeenCalled();
  });

  it("waitForActiveJobs reports a drain timeout and a completed drain", async () => {
    vi.useFakeTimers();
    const { handler, finish } = deferredHandler();
    registry.getJobHandler.mockReturnValue(handler);
    jobQueue.claimNextJob
      .mockResolvedValueOnce(makeJob({ id: "job-a", jobType: KNOWLEDGE_TYPE }))
      .mockResolvedValue(null);

    await dispatchReadyKnowledgeJobs();
    const waiting = waitForActiveJobs(500);
    await vi.advanceTimersByTimeAsync(600);
    await expect(waiting).resolves.toBe(false); // still running past the grace period

    finish("job-a");
    await vi.advanceTimersByTimeAsync(0);
    await expect(waitForActiveJobs(500)).resolves.toBe(true);
  });
});

describe("supervisor shutdown channel", () => {
  it("pins the shutdown message literal mirrored in scripts/run-app.mjs", () => {
    expect(WORKER_SHUTDOWN_MESSAGE).toBe("shutdown");
  });

  it("fires only for the shutdown control line, tolerating padding", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const onShutdown = vi.fn();
    attachSupervisorShutdownChannel(stream, onShutdown);

    stream.write("some unrelated log line\n");
    stream.write(`not-${WORKER_SHUTDOWN_MESSAGE}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShutdown).not.toHaveBeenCalled();

    stream.write(`  ${WORKER_SHUTDOWN_MESSAGE}  \n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith("supervisor shutdown message");

    // Stream end alone must never trigger shutdown: a standalone worker under a
    // service manager can have an immediately-closed stdin.
    stream.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});
