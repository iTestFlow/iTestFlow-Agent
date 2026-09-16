import { NextResponse } from "next/server";

import { requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import {
  deleteStoryAttachment,
  getStoryAttachment,
} from "@/modules/story-attachments/story-attachments.service";

import {
  StoryAttachmentRequestSchema,
  requireStoryAttachmentDeletePermission,
  resolveStoryAttachmentRouteContext,
  storyAttachmentResponse,
  storyAttachmentRouteErrorResponse,
} from "../story-attachment-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ attachmentId: string }> };

export async function DELETE(request: Request, { params }: RouteParams) {
  const parsed = StoryAttachmentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A story scope is required." }, { status: 400 });

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const context = await resolveStoryAttachmentRouteContext({ ...parsed.data, ctx });
    const { attachmentId } = await params;
    const attachment = await getStoryAttachment({ scope: context.storyScope, attachmentId });
    if (!attachment) return NextResponse.json({ error: "The requested story attachment was not found." }, { status: 404 });
    await requireStoryAttachmentDeletePermission({ ctx: context.ctx, attachment });
    const deleted = await deleteStoryAttachment({
      scope: context.storyScope,
      attachmentId,
      actor: context.ctx.userId,
    });
    if (!deleted) return NextResponse.json({ error: "The requested story attachment was not found." }, { status: 404 });
    return NextResponse.json({ attachment: storyAttachmentResponse(deleted) });
  } catch (error) {
    return storyAttachmentRouteErrorResponse(error, "The story attachment could not be removed.");
  }
}
