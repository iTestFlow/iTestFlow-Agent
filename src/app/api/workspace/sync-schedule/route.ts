import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import {
  deleteWorkspaceSyncSchedule,
  getWorkspaceSyncSchedule,
  ScheduleError,
  upsertWorkspaceSyncSchedule,
} from "@/modules/jobs/sync-schedule.service";

export const runtime = "nodejs";

const Schema = z.object({
  cronExpression: z.string().trim().min(1, "Enter a cron expression.").max(100),
  enabled: z.boolean().default(true),
});

/**
 * Per-workspace sync schedule (owner/admin only). Stores a cron expression the
 * worker uses to enqueue this workspace's context sync. The cron string is
 * validated server-side; the secret-bearing sync credential is set separately.
 */
export async function GET() {
  let context;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const schedule = await getWorkspaceSyncSchedule(context.workspace.id);
  return NextResponse.json(
    { workspaceId: context.workspace.id, schedule },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  let context;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  try {
    const schedule = await upsertWorkspaceSyncSchedule({
      workspaceId: context.workspace.id,
      cronExpression: parsed.data.cronExpression,
      enabled: parsed.data.enabled,
      createdByUserId: context.userId,
    });
    return NextResponse.json({ workspaceId: context.workspace.id, schedule });
  } catch (error) {
    if (error instanceof ScheduleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function DELETE() {
  let context;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  await deleteWorkspaceSyncSchedule(context.workspace.id);
  return NextResponse.json({ ok: true });
}
