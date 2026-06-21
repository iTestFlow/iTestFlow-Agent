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
 *       WORKER_POLL_MS         (default 2000) — idle poll interval.
 *       WORKER_AUTO_SYNC=true  — opt-in: periodically enqueue due workspace syncs.
 *       WORKER_AUTO_SYNC_MS    (default 900000 = 15m) — auto-enqueue interval.
 */
import { claimNextJob, completeJob, failJob } from "@/modules/jobs/job-queue.service";
import { getJobHandler, registeredJobTypes } from "@/modules/jobs/job-handlers";
import { registerAllJobHandlers } from "@/modules/jobs/register-handlers";
import { enqueueDueWorkspaceSyncs } from "@/modules/jobs/workspace-sync.handler";

const WORKER_ID = `worker-${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? "2000");
const AUTO_SYNC = process.env.WORKER_AUTO_SYNC === "true";
const AUTO_SYNC_MS = Number(process.env.WORKER_AUTO_SYNC_MS ?? String(15 * 60 * 1000));

let shuttingDown = false;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob(WORKER_ID);
  if (!job) return false;

  const handler = getJobHandler(job.jobType);
  if (!handler) {
    await failJob(job.id, `No handler registered for job type "${job.jobType}".`);
    console.error(`[worker] no handler for ${job.jobType} (job ${job.id})`);
    return true;
  }

  const startedAt = Date.now();
  try {
    await handler(job);
    await completeJob(job.id);
    console.log(`[worker] completed ${job.jobType} ${job.id} in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job handler failed.";
    await failJob(job.id, message);
    console.error(`[worker] failed ${job.jobType} ${job.id} (attempt ${job.attempts}/${job.maxAttempts}): ${message}`);
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

async function autoSyncLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const count = await enqueueDueWorkspaceSyncs();
      if (count) console.log(`[worker] auto-enqueued ${count} workspace sync job(s)`);
    } catch (error) {
      console.error("[worker] auto-sync enqueue failed.", error);
    }
    await sleep(AUTO_SYNC_MS);
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
  console.log(`[worker] ${WORKER_ID} started. handlers=[${registeredJobTypes().join(", ")}] poll=${POLL_MS}ms autoSync=${AUTO_SYNC}`);

  const loops = [workLoop()];
  if (AUTO_SYNC) loops.push(autoSyncLoop());
  await Promise.all(loops);
}

void main();
