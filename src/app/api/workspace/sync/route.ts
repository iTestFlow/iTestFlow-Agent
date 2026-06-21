import { NextResponse } from "next/server";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { enqueueWorkspaceContextSync } from "@/modules/jobs/workspace-sync.handler";

export const runtime = "nodejs";

/**
 * Enqueues a scheduled context-sync job for each active project in the workspace
 * (owner/admin only). The worker runs them using the workspace sync credential.
 * Enqueue is deduped, so repeated calls won't pile up duplicate active jobs.
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

  const enqueued = await enqueueWorkspaceContextSync(context.workspace.id, context.userId);
  return NextResponse.json({ ok: true, workspaceId: context.workspace.id, enqueued });
}
