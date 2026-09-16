import { NextResponse } from "next/server";

import { requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";

import {
  StoryAttachmentRequestSchema,
  parseStoryAttachmentScopeParam,
  resolveStoryAttachmentRouteContext,
  storyAttachmentRouteErrorResponse,
} from "../story-attachment-route-helpers";

export const runtime = "nodejs";

/** Lists existing Jira/Azure attachment metadata without downloading any bytes. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const scope = parseStoryAttachmentScopeParam(url.searchParams.get("scope"));
  if (!scope.success) return NextResponse.json({ error: scope.error }, { status: 400 });
  const parsed = StoryAttachmentRequestSchema.safeParse({
    scope: scope.data,
    workItemId: url.searchParams.get("workItemId") ?? "",
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A work item is required." }, { status: 400 });

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const context = await resolveStoryAttachmentRouteContext({ ...parsed.data, ctx });
    const attachments = await context.provider.fetchWorkItemAttachments({
      projectId: context.projectScope.azureProjectId,
      workItemId: parsed.data.workItemId,
    });
    // The provider re-reads and validates the owner as well; this local filter is
    // a second boundary before metadata is ever returned to the browser.
    const scoped = attachments.filter((attachment) => attachment.sourceWorkItemId === context.storyScope.canonicalStoryId);
    return NextResponse.json({
      attachments: scoped.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
        ...(attachment.createdAt ? { createdAt: attachment.createdAt } : {}),
      })),
    });
  } catch (error) {
    return storyAttachmentRouteErrorResponse(error, "Source attachments could not be loaded.");
  }
}
