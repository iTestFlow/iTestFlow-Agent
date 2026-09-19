import { NextResponse } from "next/server";

import { requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { retryStoryAttachment } from "@/modules/story-attachments/story-attachments.service";

import {
  StoryAttachmentRequestSchema,
  resolveStoryAttachmentRouteContext,
  storyAttachmentResponse,
  storyAttachmentRouteErrorResponse,
} from "../../story-attachment-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ attachmentId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = StoryAttachmentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A story scope is required." }, { status: 400 });

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const context = await resolveStoryAttachmentRouteContext({ ...parsed.data, ctx });
    const { attachmentId } = await params;
    const retried = await retryStoryAttachment({
      scope: context.storyScope,
      attachmentId,
      actor: context.ctx.userId,
    });
    if (!retried) return NextResponse.json({ error: "The requested story attachment was not found." }, { status: 404 });
    return NextResponse.json({ attachment: storyAttachmentResponse(retried.attachment), jobId: retried.jobId }, { status: 202 });
  } catch (error) {
    return storyAttachmentRouteErrorResponse(error, "The story attachment could not be queued for processing.");
  }
}
