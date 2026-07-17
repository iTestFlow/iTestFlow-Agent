/**
 * iTestFlow background worker (Phase 4).
 *
 * Runs as a separate process from the Next.js web app. It claims jobs from the
 * PostgreSQL `jobs` table (FOR UPDATE SKIP LOCKED — safe across multiple worker
 * instances) and dispatches them to registered handlers. Scheduled syncs run
 * here using the workspace sync credential, with no logged-in user.
 *
 * Execution lanes:
 *  - Knowledge Hub dispatcher: claims EVERY ready `project_knowledge_v4` job
 *    and runs each concurrently — builds for distinct projects never queue
 *    behind one another (same-project single-flight stays on the queue's
 *    dedupe key). There is intentionally no process-wide build cap.
 *  - Serial lane: workspace sync and every other job type, one at a time.
 *
 * All active jobs share one batched heartbeat and one cancellation poll,
 * tracked in a process-level map. Graceful shutdown drains active jobs for a
 * short grace period, then aborts and atomically requeues the unfinished ones
 * without consuming a retry.
 *
 * Run:  npm run worker        (production; env from the platform)
 *       npm run worker:dev    (loads .env, watch mode)
 *
 * Env:  DATABASE_URL, APP_ENCRYPTION_KEY (to decrypt the sync credential).
 *       WORKER_POLL_MS              (default 2000) — idle poll interval.
 *       WORKER_HEARTBEAT_MS         (default 30000) — batched heartbeat covering
 *                                   all active jobs.
 *       WORKER_SCHEDULER            (default on; set "false" to disable scheduling).
 *       WORKER_SCHEDULER_TICK_MS    (default 60000) — how often due schedules are
 *                                   evaluated. Each workspace's cadence is its own
 *                                   cron schedule (Settings → Workspace); a workspace
 *                                   with no schedule is a no-op.
 */
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import {
  cancelRunningJob,
  claimNextJob,
  completeJob,
  failJob,
  getRequestedJobCancellations,
  heartbeatJobs,
  isJobCancellationRequested,
  requeueOwnedJobs,
  updateJobProgress,
  type Job,
} from "@/modules/jobs/job-queue.service";
import { getJobHandler, registeredJobTypes, type JobHandler } from "@/modules/jobs/job-handlers";
import { PROJECT_KNOWLEDGE_JOB } from "@/modules/jobs/project-knowledge-jobs.service";
import { registerAllJobHandlers } from "@/modules/jobs/register-handlers";
import { enqueueDueScheduledSyncs } from "@/modules/jobs/sync-schedule.service";
import {
  heartbeatWorkerInstance,
  registerWorkerInstance,
  removeStaleWorkerInstances,
  unregisterWorkerInstance,
  WORKER_REGISTRY_HEARTBEAT_MS,
} from "@/modules/jobs/worker-registry.service";

export const WORKER_ID = process.env.WORKER_ID ?? `worker-${hostname()}-${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? "2000");
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? String(30 * 1000));
const SCHEDULER_ENABLED = process.env.WORKER_SCHEDULER !== "false";
const SCHEDULER_TICK_MS = Number(process.env.WORKER_SCHEDULER_TICK_MS ?? String(60 * 1000));
const CANCELLATION_POLL_MS = 1000;
const SHUTDOWN_GRACE_MS = 3000;
// Failsafe: never wedge on an unreachable database mid-shutdown.
const SHUTDOWN_DEADLINE_MS = 10_000;
// Initial registration retries while the web process's startup migration is
// still creating worker_instances (fresh database), instead of crash-looping.
const REGISTRATION_RETRY_MS = 5_000;
const REGISTRATION_DEADLINE_MS = 120_000;

let shuttingDown = false;
let registryHeartbeat: ReturnType<typeof setInterval> | null = null;

type ActiveJob = {
  job: Job;
  abortController: AbortController;
  /** Set only by shutdown, before abort: the run must leave the row 'running' for the fenced requeue. */
  abortedForShutdown: boolean;
  /** Never-rejecting run promise; the dispatcher does not await it. */
  promise: Promise<void>;
};

const activeJobs = new Map<string, ActiveJob>();
let batchedHeartbeat: ReturnType<typeof setInterval> | null = null;
let cancellationPoll: ReturnType<typeof setInterval> | null = null;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * One heartbeat and one cancellation poll cover every active job. Started when
 * the first job registers, stopped when the last one settles, so an idle
 * worker issues no no-op queries.
 */
function ensureJobTimers() {
  if (!batchedHeartbeat) {
    batchedHeartbeat = setInterval(() => {
      const ids = [...activeJobs.keys()];
      if (ids.length === 0) return;
      void heartbeatJobs(ids, WORKER_ID)
        .then((ownedIds) => {
          const owned = new Set(ownedIds);
          for (const id of ids) {
            // Only warn while the job is still active locally — one that
            // completed between snapshot and response is not a lost lock.
            if (!owned.has(id) && activeJobs.has(id)) {
              console.warn(`[worker] heartbeat lost ownership of job ${id}`);
            }
          }
        })
        .catch((error) => console.error("[worker] batched heartbeat failed", error));
    }, HEARTBEAT_MS);
    batchedHeartbeat.unref();
  }
  if (!cancellationPoll) {
    cancellationPoll = setInterval(() => {
      const ids = [...activeJobs.keys()];
      if (ids.length === 0) return;
      void getRequestedJobCancellations(ids, WORKER_ID)
        .then((cancelledIds) => {
          for (const id of cancelledIds) {
            activeJobs.get(id)?.abortController.abort(new Error("Job cancellation requested."));
          }
        })
        .catch((error) => console.error("[worker] cancellation poll failed", error));
    }, CANCELLATION_POLL_MS);
    cancellationPoll.unref();
  }
}

function clearJobTimersIfIdle() {
  if (activeJobs.size > 0) return;
  if (batchedHeartbeat) {
    clearInterval(batchedHeartbeat);
    batchedHeartbeat = null;
  }
  if (cancellationPoll) {
    clearInterval(cancellationPoll);
    cancellationPoll = null;
  }
}

/**
 * Registers a claimed job in the active map and starts its handler. The
 * returned promise never rejects — the knowledge dispatcher does not await it,
 * and an unhandled rejection would crash the worker.
 */
function startClaimedJob(job: Job): { promise: Promise<void> } {
  const handler = getJobHandler(job.jobType);
  if (!handler) {
    const promise = failJob(job.id, `No handler registered for job type "${job.jobType}".`, WORKER_ID)
      .then(() => {
        console.error(`[worker] no handler for ${job.jobType} (job ${job.id})`);
      })
      .catch((error) => console.error(`[worker] failed to fail handlerless job ${job.id}`, error));
    return { promise };
  }
  const entry: ActiveJob = {
    job,
    abortController: new AbortController(),
    abortedForShutdown: false,
    promise: Promise.resolve(),
  };
  activeJobs.set(job.id, entry);
  ensureJobTimers();
  entry.promise = executeJob(handler, entry)
    .catch((error) => console.error(`[worker] unexpected dispatch error for ${job.jobType} ${job.id}`, error))
    .finally(() => {
      activeJobs.delete(job.id);
      clearJobTimersIfIdle();
    });
  return entry;
}

async function executeJob(handler: JobHandler, entry: ActiveJob): Promise<void> {
  const { job, abortController } = entry;
  const startedAt = Date.now();
  try {
    const handlerResult = await handler(job, {
      workerId: WORKER_ID,
      signal: abortController.signal,
      updateProgress: async (progress) => {
        if (abortController.signal.aborted) throw abortController.signal.reason;
        const updated = await updateJobProgress(job.id, WORKER_ID, progress);
        if (!updated) throw new Error("The worker no longer owns this job.");
      },
    });
    if (entry.abortedForShutdown) return; // row stays 'running' for the shutdown requeue
    if (abortController.signal.aborted || await isJobCancellationRequested(job.id, WORKER_ID)) {
      await cancelRunningJob(job.id, WORKER_ID);
      console.log(`[worker] cancelled ${job.jobType} ${job.id}`);
      return;
    }
    const completed = await completeJob(job.id, WORKER_ID, handlerResult ?? null);
    if (completed) {
      console.log(`[worker] completed ${job.jobType} ${job.id} in ${Date.now() - startedAt}ms`);
    } else {
      console.warn(`[worker] skipped completion for ${job.jobType} ${job.id}; lock is no longer owned by ${WORKER_ID}`);
    }
  } catch (error) {
    if (entry.abortedForShutdown) return; // row stays 'running' for the shutdown requeue
    if (abortController.signal.aborted || await isJobCancellationRequested(job.id, WORKER_ID)) {
      await cancelRunningJob(job.id, WORKER_ID);
      console.log(`[worker] cancelled ${job.jobType} ${job.id}`);
      return;
    }
    const message = error instanceof Error ? error.message : "Job handler failed.";
    const failed = await failJob(job.id, message, WORKER_ID);
    if (!failed) {
      console.warn(`[worker] skipped failure update for ${job.jobType} ${job.id}; lock is no longer owned by ${WORKER_ID}`);
    }
    console.error(`[worker] failed ${job.jobType} ${job.id} (attempt ${job.attempts}/${job.maxAttempts}): ${message}`);
  }
}

function serialJobTypes(): string[] {
  return registeredJobTypes().filter((jobType) => jobType !== PROJECT_KNOWLEDGE_JOB);
}

/**
 * Serial lane: claims and dispatches a single non-knowledge job to completion.
 * Returns true when a job was claimed (the loop should immediately poll again)
 * and false when the queue was idle. Exported for tests.
 */
export async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob(WORKER_ID, serialJobTypes());
  if (!job) return false;
  await startClaimedJob(job).promise;
  return true;
}

/**
 * Knowledge Hub dispatcher: claims every ready knowledge job and starts each
 * without awaiting it, so builds for distinct projects run concurrently. Each
 * successful claim commits `pending -> running`, so the ready set strictly
 * shrinks and the drain cannot busy-spin. The stale reap runs once per drain
 * tick instead of once per claim. Exported for tests.
 */
export async function dispatchReadyKnowledgeJobs(): Promise<number> {
  let claimed = 0;
  while (!shuttingDown) {
    const job = await claimNextJob(WORKER_ID, [PROJECT_KNOWLEDGE_JOB], { reapStale: claimed === 0 });
    if (!job) break;
    startClaimedJob(job);
    claimed += 1;
  }
  return claimed;
}

async function serialWorkLoop(): Promise<void> {
  while (!shuttingDown) {
    let processed = false;
    try {
      processed = await processNextJob();
    } catch (error) {
      console.error("[worker] claim loop error; backing off.", error);
      await sleep(POLL_MS);
      continue;
    }
    // Drain the queue back-to-back; only idle-poll when empty.
    if (!processed) await sleep(POLL_MS);
  }
}

async function knowledgeDispatchLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      await dispatchReadyKnowledgeJobs();
    } catch (error) {
      console.error("[worker] knowledge dispatch error; backing off.", error);
    }
    // Claimed builds keep running concurrently; only the claim loop sleeps.
    await sleep(POLL_MS);
  }
}

async function schedulerLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const fired = await enqueueDueScheduledSyncs();
      if (fired) console.log(`[worker] scheduler fired ${fired} workspace schedule(s)`);
    } catch (error) {
      console.error("[worker] scheduler tick failed.", error);
    }
    await sleep(SCHEDULER_TICK_MS);
  }
}

/**
 * Waits up to graceMs for every active job to settle. Polls the LIVE map (not
 * a snapshot) so a claim that raced the shutdown flag is still covered.
 * Exported for tests.
 */
export async function waitForActiveJobs(graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (activeJobs.size > 0 && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...activeJobs.values()].map((entry) => entry.promise)),
      sleep(Math.min(100, Math.max(1, deadline - Date.now()))),
    ]);
  }
  return activeJobs.size === 0;
}

/**
 * Aborts every remaining owned job and atomically returns them to 'pending'
 * without consuming a retry. The shutdown flag is set BEFORE abort so the
 * unwinding handlers skip cancel/fail finalization and leave their rows
 * 'running' + owned until the single fenced requeue UPDATE flips them; any
 * handler write landing after it is a fenced no-op. Exported for tests.
 */
export async function requeueUnfinishedJobsForShutdown(): Promise<number> {
  const remaining = [...activeJobs.values()];
  for (const entry of remaining) {
    entry.abortedForShutdown = true;
    entry.abortController.abort(new Error("The worker is shutting down."));
  }
  return requeueOwnedJobs(remaining.map((entry) => entry.job.id), WORKER_ID);
}

async function performShutdown(): Promise<void> {
  if (registryHeartbeat) clearInterval(registryHeartbeat);
  // Stop advertising capacity first so enqueue-side health checks route new
  // builds to surviving workers.
  await unregisterWorkerInstance(WORKER_ID)
    .catch((error) => console.error("[worker] failed to remove worker registration.", error));
  const drained = await waitForActiveJobs(SHUTDOWN_GRACE_MS);
  if (!drained) {
    const requeued = await requeueUnfinishedJobsForShutdown()
      .catch((error) => {
        console.error("[worker] shutdown requeue failed.", error);
        return 0;
      });
    console.log(`[worker] requeued ${requeued} unfinished job(s) for another worker.`);
  }
}

function installShutdown() {
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received; draining ${activeJobs.size} active job(s).`);
    setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    void performShutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function registerWorkerInstanceWithRetry(capabilities: string[]) {
  const deadline = Date.now() + REGISTRATION_DEADLINE_MS;
  for (;;) {
    try {
      await registerWorkerInstance({ id: WORKER_ID, capabilities });
      return;
    } catch (error) {
      if (shuttingDown || Date.now() >= deadline) throw error;
      console.error(`[worker] registration failed; retrying in ${REGISTRATION_RETRY_MS / 1000}s (the database may still be migrating).`, error);
      await sleep(REGISTRATION_RETRY_MS);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[worker] DATABASE_URL is not set. See .env.example.");
    process.exit(1);
  }
  registerAllJobHandlers();
  const capabilities = registeredJobTypes();
  await registerWorkerInstanceWithRetry(capabilities);
  await removeStaleWorkerInstances();
  registryHeartbeat = setInterval(() => {
    void heartbeatWorkerInstance(WORKER_ID)
      .then(async (updated) => {
        if (!updated) await registerWorkerInstance({ id: WORKER_ID, capabilities });
      })
      .catch((error) => console.error("[worker] availability heartbeat failed.", error));
  }, WORKER_REGISTRY_HEARTBEAT_MS);
  registryHeartbeat.unref();
  installShutdown();
  console.log(`[worker] ${WORKER_ID} started. handlers=[${capabilities.join(", ")}] poll=${POLL_MS}ms scheduler=${SCHEDULER_ENABLED}`);

  const loops = [serialWorkLoop()];
  if (capabilities.includes(PROJECT_KNOWLEDGE_JOB)) loops.push(knowledgeDispatchLoop());
  if (SCHEDULER_ENABLED) loops.push(schedulerLoop());
  await Promise.all(loops);
}

// Auto-start only when this module's resolved URL is the process entrypoint.
// Importing it from tests or another module must not start the loops.
const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
const isProcessEntrypoint = entrypointUrl === import.meta.url;
if (isProcessEntrypoint) {
  void main().catch((error) => {
    console.error("[worker] failed to start.", error);
    process.exit(1);
  });
}
