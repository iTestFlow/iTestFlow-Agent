import "server-only";

import type { Job } from "./job-queue.service";

/** Maps a job_type to its handler. The worker registers all handlers at startup. */
export type JobHandler = (job: Job) => Promise<void>;

const registry = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, handler: JobHandler): void {
  registry.set(jobType, handler);
}

export function getJobHandler(jobType: string): JobHandler | undefined {
  return registry.get(jobType);
}

export function registeredJobTypes(): string[] {
  return [...registry.keys()];
}
