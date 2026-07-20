import { NextResponse } from "next/server";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { enqueueWorkspaceContextSync, WORKSPACE_CONTEXT_SYNC } from "@/modules/jobs/workspace-sync.handler";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";

export const runtime = "nodejs";

const WORKSPACE_SYNC_UNAVAILABLE_CODE = "workspace_sync_unavailable";
const WORKSPACE_SYNC_UNAVAILABLE_MESSAGE = "Workspace sync is temporarily unavailable. Please try again shortly.";

/**
 * Enqueues a scheduled context-sync job for each active project in the workspace
 * (owner/admin only). The worker runs them using the workspace sync credential.
 * Enqueue is deduped, so repeated calls won't pile up duplicate active jobs.
 * Rejected before enqueue while no healthy worker holds the sync capability, so
 * a web-only deployment fails fast instead of queuing jobs nothing will run.
 */
export async function POST() {
  let context;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  if (!await hasHealthyWorkerCapability(WORKSPACE_CONTEXT_SYNC)) {
    return NextResponse.json({ error: WORKSPACE_SYNC_UNAVAILABLE_MESSAGE, code: WORKSPACE_SYNC_UNAVAILABLE_CODE }, {
      status: 503,
      headers: { "Retry-After": "5" },
    });
  }

  const enqueued = await enqueueWorkspaceContextSync(context.workspace.id, context.userId);
  return NextResponse.json({ ok: true, workspaceId: context.workspace.id, enqueued });
}
