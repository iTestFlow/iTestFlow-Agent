import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { requireSession } from "@/modules/auth/session.service";
import {
  removeStreamedDocumentMultipart,
  streamDocumentUploadMultipart,
  type StreamedDocumentMultipart,
} from "@/modules/documents/streaming-multipart-upload";
import {
  createStoryAttachment,
  listStoryAttachments,
} from "@/modules/story-attachments/story-attachments.service";

import {
  StoryAttachmentRequestSchema,
  parseStoryAttachmentScopeParam,
  resolveStoryAttachmentRouteContext,
  storyAttachmentResponse,
  storyAttachmentRouteErrorResponse,
} from "./story-attachment-route-helpers";

export const runtime = "nodejs";

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
    const attachments = await listStoryAttachments({ scope: context.storyScope });
    return NextResponse.json({ attachments: attachments.map(storyAttachmentResponse) });
  } catch (error) {
    return storyAttachmentRouteErrorResponse(error, "Story attachments could not be loaded.");
  }
}

/**
 * Receives files only after a signed-in session is confirmed. The multipart
 * parser then requires the scope field before file bytes, and the trusted
 * story resolver verifies the caller can still read that story before storage.
 */
export async function POST(request: Request) {
  try {
    await requireSession();
  } catch (error) {
    return storyAttachmentRouteErrorResponse(error, "Sign in to upload story attachments.");
  }

  let multipart: StreamedDocumentMultipart | undefined;
  try {
    multipart = await streamDocumentUploadMultipart(request);
    const parsed = parseUploadMetadata(multipart.fields);
    if (!parsed.success) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const context = await resolveStoryAttachmentRouteContext({ ...parsed.data, ctx });
    const uploads: Array<Record<string, unknown>> = [];
    const failures: Array<{ clientIndex: number; fileName: string; error: string }> = [];

    for (const [clientIndex, file] of multipart.files.entries()) {
      try {
        const bytes = await readFile(file.tempPath);
        if (bytes.byteLength !== file.byteSize) throw new Error("The temporary upload changed before it could be stored.");
        const created = await createStoryAttachment({
          scope: context.storyScope,
          actor: context.ctx.userId,
          source: { kind: "upload" },
          fileName: file.originalFileName,
          declaredMimeType: file.mimeType,
          bytes,
        });
        uploads.push({
          clientIndex,
          attachment: storyAttachmentResponse(created.attachment),
          jobId: created.jobId,
          reused: created.reused,
        });
      } catch (error) {
        failures.push({
          clientIndex,
          fileName: file.originalFileName,
          error: error instanceof Error ? error.message : "This file could not be added to the story.",
        });
      }
    }

    return NextResponse.json({ uploads, failures }, { status: uploads.length ? 202 : 400 });
  } catch (error) {
    return storyAttachmentRouteErrorResponse(error, "Story attachments could not be uploaded.");
  } finally {
    if (multipart) await removeStreamedDocumentMultipart(multipart).catch(() => undefined);
  }
}

function parseUploadMetadata(fields: Record<string, string>):
  | { success: true; data: { scope: import("@/modules/projects/project-isolation.guard").ProjectScope; workItemId: string } }
  | { success: false; error: string } {
  const allowed = new Set(["scope", "workItemId"]);
  const unexpected = Object.keys(fields).find((key) => !allowed.has(key));
  if (unexpected) return { success: false, error: `Unexpected multipart field: ${unexpected}.` };
  let scope: unknown;
  try {
    scope = JSON.parse(fields.scope ?? "");
  } catch {
    return { success: false, error: "The project scope must be valid JSON." };
  }
  const parsed = StoryAttachmentRequestSchema.safeParse({ scope, workItemId: fields.workItemId });
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Attachment upload metadata is invalid." };
  return { success: true, data: parsed.data };
}
