import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
export const isProcessEntrypoint = entrypointUrl === import.meta.url;
const mode = process.argv[2];
if (isProcessEntrypoint && mode !== "dev" && mode !== "start") {
  console.error("Usage: node scripts/run-app.mjs <dev|start> [...web arguments]");
  process.exit(1);
}

const passthrough = process.argv.slice(3);
const root = fileURLToPath(new URL("../", import.meta.url));
const nextDev = fileURLToPath(new URL("./next-dev.mjs", import.meta.url));
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const workerMain = fileURLToPath(new URL("../src/worker/main.ts", import.meta.url));
const restartDelays = [1_000, 2_000, 5_000, 15_000, 30_000];

// Mirrored in src/worker/main.ts (an .mjs script cannot import the TS constant).
// A control message over the worker's piped stdin triggers the same graceful
// unregister -> drain -> no-retry requeue path as SIGTERM. On Windows,
// child.kill() is an abrupt TerminateProcess that would skip that path, fall
// back to ~5-minute stale-lock recovery, and burn one of the job's attempts.
export const WORKER_SHUTDOWN_MESSAGE = "shutdown";
// Must outlive the worker's internal SHUTDOWN_DEADLINE_MS (10s failsafe).
const WORKER_STOP_KILL_FALLBACK_MS = 12_000;

let shuttingDown = false;
let webProcess;
let workerProcess;
let workerRestartTimer;
let workerRestartAttempt = 0;
let workerStartedAt = 0;

function spawnChild(args, stdio = "inherit") {
  return spawn(process.execPath, args, {
    cwd: root,
    stdio,
    env: process.env,
  });
}

function startWeb() {
  webProcess = mode === "dev"
    ? spawnChild([nextDev, ...passthrough])
    : spawnChild([nextBin, "start", ...passthrough]);
  webProcess.once("error", (error) => stopApplication(1, `Web service failed to start: ${error.message}`));
  webProcess.once("exit", (code, signal) => {
    if (shuttingDown) return;
    stopApplication(code ?? 1, `Web service exited${signal ? ` after ${signal}` : ` with code ${code ?? 1}`}.`);
  });
}

function workerArguments() {
  const args = ["--env-file-if-exists=.env", "--conditions=react-server"];
  if (mode === "dev") args.push("--watch");
  args.push("--import", "tsx", workerMain);
  return args;
}

function startWorker() {
  if (shuttingDown) return;
  workerStartedAt = Date.now();
  workerProcess = spawnChild(workerArguments(), ["pipe", "inherit", "inherit"]);
  workerProcess.once("error", (error) => scheduleWorkerRestart(`Generation service failed to start: ${error.message}`));
  workerProcess.once("exit", (code, signal) => {
    if (shuttingDown) return;
    scheduleWorkerRestart(`Generation service exited${signal ? ` after ${signal}` : ` with code ${code ?? 1}`}.`);
  });
}

function scheduleWorkerRestart(reason) {
  if (shuttingDown || workerRestartTimer) return;
  if (Date.now() - workerStartedAt >= 60_000) workerRestartAttempt = 0;
  const delay = restartDelays[Math.min(workerRestartAttempt, restartDelays.length - 1)];
  workerRestartAttempt += 1;
  console.error(`[app] ${reason} Restarting generation capacity in ${Math.round(delay / 1000)}s.`);
  workerRestartTimer = setTimeout(() => {
    workerRestartTimer = undefined;
    startWorker();
  }, delay);
}

function stopChild(child, signal) {
  if (child && child.exitCode === null && !child.killed) child.kill(signal);
}

/**
 * Asks the worker to shut down gracefully over its piped stdin. Returns false
 * when the message could not be delivered (worker already gone, stdin closed),
 * in which case the caller falls back to a signal kill. Exported for tests.
 */
export function requestWorkerShutdown(child) {
  if (!child || child.exitCode !== null || child.killed || !child.stdin || child.stdin.destroyed) return false;
  try {
    child.stdin.write(`${WORKER_SHUTDOWN_MESSAGE}\n`);
    child.stdin.end();
    return true;
  } catch {
    return false;
  }
}

function stopApplication(exitCode, reason, signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  if (reason) console.error(`[app] ${reason}`);
  if (workerRestartTimer) clearTimeout(workerRestartTimer);
  stopChild(webProcess, signal);
  if (requestWorkerShutdown(workerProcess)) {
    const worker = workerProcess;
    const killFallback = setTimeout(() => stopChild(worker, signal), WORKER_STOP_KILL_FALLBACK_MS);
    killFallback.unref();
    worker.once("exit", () => clearTimeout(killFallback));
  } else {
    stopChild(workerProcess, signal);
  }
  // Must outlive the worker's graceful window (message fallback 12s + margin).
  setTimeout(() => process.exit(exitCode), 15_000).unref();
}

export function workerRestartDelay(attempt) {
  return restartDelays[Math.min(Math.max(0, attempt), restartDelays.length - 1)];
}

if (isProcessEntrypoint) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => stopApplication(0, undefined, signal));
  }
  startWorker();
  startWeb();
}
