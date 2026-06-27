import { NextResponse } from "next/server";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { listJobs } from "@/modules/jobs/job-queue.service";

export const runtime = "nodejs";

/** Lists recent background jobs for the caller's workspace (any member). */
export async function GET() {
  let context;
  try {
    context = await resolveWorkspaceRequest();
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const jobs = await listJobs(context.workspace.id, 50);
  return NextResponse.json(
    {
      workspaceId: context.workspace.id,
      jobs: jobs.map((job) => ({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
