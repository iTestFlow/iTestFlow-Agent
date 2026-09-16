import { NextResponse } from "next/server";
import { z } from "zod";

import { requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import {
  createStoryAttachment,
} from "@/modules/story-attachments/story-attachments.service";

import {
  StoryAttachmentRequestSchema,
  resolveStoryAttachmentRouteContext,
  storyAttachmentResponse,
  storyAttachmentRouteErrorResponse,
} from "../story-attachment-route-helpers";

export const runtime = "nodejs";

const RequestSchema = StoryAttachmentRequestSchema.extend({
  attachmentId: z.string().trim().min(1).max(512),
}).strict();

/**
 * Copies an existing Azure/Jira attachment into iTestFlow's isolated storage.
 * It never writes to or deletes from the upstream work-management provider.
 */
export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A source attachment is required." }, { status: 400 });

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const context = await resolveStoryAttachmentRouteContext({ ...parsed.data, ctx });
    const downloaded = await context.provider.downloadWorkItemAttachment({
      projectId: context.projectScope.azureProjectId,
      workItemId: parsed.data.workItemId,
      attachmentId: parsed.data.attachmentId,
    });
    // Both providers re-check this before bytes are returned. Keep an explicit
    // route-level check so a malformed adapter response cannot cross stories.
    if (downloaded.attachment.sourceWorkItemId !== context.storyScope.canonicalStoryId) {
      return NextResponse.json({ error: "The requested source attachment was not found on this work item." }, { status: 404 });
    }

    const sourceKind = context.storyScope.providerId === "jira-cloud"
      ? "jira_attachment" as const
      : "azure_devops_attachment" as const;
    const created = await createStoryAttachment({
      scope: context.storyScope,
      actor: context.ctx.userId,
      source: {
        kind: sourceKind,
        externalAttachmentId: downloaded.attachment.id,
        metadata: {
          fileName: downloaded.attachment.fileName,
          ...(downloaded.attachment.contentType ? { contentType: downloaded.attachment.contentType } : {}),
          ...(downloaded.attachment.size !== undefined ? { byteSize: downloaded.attachment.size } : {}),
          ...(downloaded.attachment.createdAt ? { createdAt: downloaded.attachment.createdAt } : {}),
        },
      },
      fileName: downloaded.attachment.fileName,
      declaredMimeType: downloaded.attachment.contentType,
      bytes: new Uint8Array(downloaded.content),
    });
    return NextResponse.json({
      attachment: storyAttachmentResponse(created.attachment),
      jobId: created.jobId,
      reused: created.reused,
    }, { status: 202 });
  } catch (error) {
    return storyAttachmentRouteErrorResponse(error, "The source attachment could not be imported.");
  }
}
