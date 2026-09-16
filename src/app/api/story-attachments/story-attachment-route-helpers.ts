import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  getUserWorkManagementProvider,
  WorkflowAuthError,
  type WorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";
import type { WorkManagementProvider } from "@/modules/integrations/core/work-management-provider";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  StoryAttachmentNotReadyError,
  StoryAttachmentValidationError,
  type StoryAttachment,
  type StoryAttachmentScope,
} from "@/modules/story-attachments/story-attachments.service";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";

export const StoryAttachmentRequestSchema = z.object({
  scope: ProjectScopeSchema,
  workItemId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Enter a valid work item ID or Jira key."),
});

export type StoryAttachmentRouteContext = {
  ctx: WorkflowContext;
  projectScope: ProjectScope;
  provider: WorkManagementProvider;
  storyScope: StoryAttachmentScope;
};

export function parseStoryAttachmentScopeParam(value: string | null):
  | { success: true; data: ProjectScope }
  | { success: false; error: string } {
  if (!value?.trim()) return { success: false, error: "A project scope is required." };
  try {
    const parsed = ProjectScopeSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return { success: false, error: "A valid project scope is required." };
    return { success: true, data: parsed.data };
  } catch {
    return { success: false, error: "The project scope must be valid JSON." };
  }
}

/**
 * Resolves the trusted project and current provider work-item access before any
 * attachment read/write. Jira issue keys are mutable display values, so the
 * persisted scope uses `raw.id` (the numeric issue ID) whenever available.
 */
export async function resolveStoryAttachmentRouteContext(input: {
  ctx: WorkflowContext;
  scope: ProjectScope;
  workItemId: string;
}): Promise<StoryAttachmentRouteContext> {
  const projectScope = await resolveProjectScope(input.ctx, input.scope);
  const provider = await getUserWorkManagementProvider(input.ctx, projectScope);
  const target = await provider.fetchWorkItemById({
    projectId: projectScope.azureProjectId,
    workItemId: input.workItemId,
  });
  const providerId = resolveWorkspaceProviderId(input.ctx.workspace);
  return {
    ctx: input.ctx,
    projectScope,
    provider,
    storyScope: {
      workspaceId: input.ctx.workspace.id,
      projectId: projectScope.projectId,
      providerId,
      canonicalStoryId: stableWorkItemId(target),
      storyDisplayKey: target.id.trim() || input.workItemId.trim(),
    },
  };
}

export function storyAttachmentResponse(attachment: StoryAttachment) {
  return {
    id: attachment.id,
    originalFileName: attachment.originalFileName,
    mimeType: attachment.mimeType,
    fileFormat: attachment.fileFormat,
    byteSize: attachment.byteSize,
    parseStatus: attachment.parseStatus,
    parseWarnings: attachment.parseWarnings,
    parseError: attachment.parseError,
    sourceKind: attachment.source.kind,
    createdBy: attachment.createdBy,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

export function storyAttachmentRouteErrorResponse(error: unknown, fallback: string) {
  const authResponse = authErrorResponse(error);
  if (authResponse) return authResponse;
  return storyAttachmentInputErrorResponse(error) ?? routeErrorResponse(error, { fallback });
}

/** Returns only client-safe attachment selection errors for use by other workflow routes. */
export function storyAttachmentInputErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof StoryAttachmentValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof StoryAttachmentNotReadyError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return null;
}

/** Uploaders retain control of their saved copy; workspace owners/admins can remove it for the story. */
export async function requireStoryAttachmentDeletePermission(input: {
  ctx: WorkflowContext;
  attachment: Pick<StoryAttachment, "createdBy">;
}) {
  if (input.attachment.createdBy === input.ctx.userId) return;
  const membership = await getWorkspaceMembership(input.ctx.userId, input.ctx.workspace.id);
  if (membership?.role === "owner" || membership?.role === "admin") return;
  throw new WorkflowAuthError("Only the attachment uploader or a workspace owner/admin can remove this saved attachment.", 403);
}

function stableWorkItemId(target: { id: string; raw?: unknown }) {
  const raw = target.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
  }
  return target.id.trim();
}
