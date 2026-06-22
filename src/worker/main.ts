/**
 * iTestFlow background worker (Phase 4).
 *
 * Runs as a separate process from the Next.js web app. It claims jobs from the
 * PostgreSQL `jobs` table (FOR UPDATE SKIP LOCKED — safe across multiple worker
 * instances) and dispatches them to registered handlers. Scheduled syncs run
 * here using the workspace sync credential, with no logged-in user.
 *
 * Run:  npm run worker        (production; env from the platform)
 *       npm run worker:dev    (loads .env, watch mode)
 *
 * Env:  DATABASE_URL, APP_ENCRYPTION_KEY (to decrypt the sync credential).
 *       WORKER_POLL_MS              (default 2000) — idle poll interval.
 *       WORKER_SCHEDULER            (default on; set "false" to disable scheduling).
 *       WORKER_SCHEDULER_TICK_MS    (default 60000) — how often due schedules are
 *                                   evaluated. Each workspace's cadence is its own
 *                                   cron schedule (Settings → Workspace); a workspace
 *                                   with no schedule is a no-op.
 */
import { claimNextJob, completeJob, failJob, heartbeatJob } from "@/modules/jobs/job-queue.service";
import { getJobHandler, registeredJobTypes } from "@/modules/jobs/job-handlers";
import { registerAllJobHandlers } from "@/modules/jobs/register-handlers";
import { enqueueDueScheduledSyncs } from "@/modules/jobs/sync-schedule.service";

const WORKER_ID = `worker-${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? "2000");
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? String(30 * 1000));
const SCHEDULER_ENABLED = process.env.WORKER_SCHEDULER !== "false";
const SCHEDULER_TICK_MS = Number(process.env.WORKER_SCHEDULER_TICK_MS ?? String(60 * 1000));

let shuttingDown = false;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob(WORKER_ID);
  if (!job) return false;

  const handler = getJobHandler(job.jobType);
  if (!handler) {
    await failJob(job.id, `No handler registered for job type "${job.jobType}".`, WORKER_ID);
    console.error(`[worker] no handler for ${job.jobType} (job ${job.id})`);
    return true;
  }

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    void heartbeatJob(job.id, WORKER_ID)
      .then((updated) => {
        if (!updated) console.warn(`[worker] heartbeat lost ownership of ${job.jobType} ${job.id}`);
      })
      .catch((error) => {
        console.error(`[worker] heartbeat failed for ${job.jobType} ${job.id}`, error);
      });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    await handler(job);
    const completed = await completeJob(job.id, WORKER_ID);
    if (completed) {
      console.log(`[worker] completed ${job.jobType} ${job.id} in ${Date.now() - startedAt}ms`);
    } else {
      console.warn(`[worker] skipped completion for ${job.jobType} ${job.id}; lock is no longer owned by ${WORKER_ID}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job handler failed.";
    const failed = await failJob(job.id, message, WORKER_ID);
    if (!failed) {
      console.warn(`[worker] skipped failure update for ${job.jobType} ${job.id}; lock is no longer owned by ${WORKER_ID}`);
    }
    console.error(`[worker] failed ${job.jobType} ${job.id} (attempt ${job.attempts}/${job.maxAttempts}): ${message}`);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function workLoop(): Promise<void> {
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

function installShutdown() {
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received; finishing current job then exiting.`);
    // Give the in-flight job a moment, then exit.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[worker] DATABASE_URL is not set. See .env.example.");
    process.exit(1);
  }
  registerAllJobHandlers();
  installShutdown();
  console.log(`[worker] ${WORKER_ID} started. handlers=[${registeredJobTypes().join(", ")}] poll=${POLL_MS}ms scheduler=${SCHEDULER_ENABLED}`);

  const loops = [workLoop()];
  if (SCHEDULER_ENABLED) loops.push(schedulerLoop());
  await Promise.all(loops);
}

void main();
