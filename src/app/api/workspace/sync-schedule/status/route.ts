import { NextResponse } from "next/server";

import { getWorkspaceSyncSchedule } from "@/modules/jobs/sync-schedule.service";
import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";

export const runtime = "nodejs";

/**
 * Read-only workspace sync schedule status for the app header. This exposes no
 * credentials or management ability; owner/admin checks remain on the settings
 * schedule endpoint.
 */
export async function GET() {
  let context;
  try {
    context = await resolveWorkspaceRequest();
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const schedule = await getWorkspaceSyncSchedule(context.workspace.id);
  return NextResponse.json(
    {
      workspaceId: context.workspace.id,
      schedule: schedule
        ? {
            enabled: schedule.enabled,
            nextRunAt: schedule.nextRunAt,
            lastEnqueuedAt: schedule.lastEnqueuedAt,
          }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
