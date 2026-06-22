import "server-only";

import { NextResponse } from "next/server";
import { AzureDevOpsRestAdapter } from "@/modules/integrations/azure-devops/azure-devops-client";
import { createLLMProvider } from "@/modules/llm/llm-provider.factory";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { DEFAULT_RETRY_ATTEMPTS, getMaxOutputTokenCapDefaultFromEnv } from "@/modules/llm/llm-defaults";
import { requireSession, SessionError } from "@/modules/auth/session.service";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";
import { getPrimaryWorkspaceForUser, getWorkspaceById, type WorkspaceRef } from "@/modules/workspace/workspace.service";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { resolveUserAzurePat, resolveUserLlmConfig, markUserAzurePatExpired } from "./credential.service";

/**
 * Per-request credential resolution for workspace features (the Phase 3 pattern,
 * proven here on one route). Resolves the authenticated user and their workspace,
 * then builds an Azure DevOps adapter and LLM provider from THAT user's encrypted
 * credentials — never from global runtime settings or client-supplied secrets.
 *
 * The Azure organization URL comes from the workspace (server-side, trusted); the
 * project identity is still taken from the client's ProjectScope for now —
 * validating the project belongs to the workspace is a Phase 3 refinement once
 * projects carry workspace_id.
 */

export class WorkflowAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WorkflowAuthError";
    this.status = status;
  }
}

export type WorkflowContext = {
  userId: string;
  workspace: WorkspaceRef;
};

/**
 * Resolves the authenticated user + the target workspace and verifies membership.
 * When the client supplies a workspaceId (via scope.workspaceId), that workspace
 * is used and membership is validated; otherwise the user's primary workspace is
 * used. Never trusts a client workspace the user isn't a member of.
 */
export async function requireWorkflowContext(workspaceId?: string | null): Promise<WorkflowContext> {
  const session = await requireSession();
  const workspace = workspaceId
    ? await getWorkspaceById(workspaceId)
    : await getPrimaryWorkspaceForUser(session.userId);
  if (!workspace) {
    throw new WorkflowAuthError(
      workspaceId ? "Workspace not found." : "No workspace membership found for this user.",
      workspaceId ? 404 : 403,
    );
  }
  const membership = await getWorkspaceMembership(session.userId, workspace.id);
  if (!membership) throw new WorkflowAuthError("You do not have access to this workspace.", 403);
  return { userId: session.userId, workspace };
}

export async function getUserAzureAdapter(
  ctx: WorkflowContext,
  project: { azureProjectId: string; azureProjectName: string },
): Promise<AzureDevOpsRestAdapter> {
  const pat = await resolveUserAzurePat(ctx.workspace.id, ctx.userId);
  if (!pat) {
    throw new WorkflowAuthError(
      "Add your Azure DevOps Personal Access Token in Settings → My Credentials before running this action.",
      400,
    );
  }
  return new AzureDevOpsRestAdapter(
    { organizationUrl: ctx.workspace.azureOrgUrl, personalAccessToken: pat },
    { azureProjectId: project.azureProjectId, azureProjectName: project.azureProjectName },
    expirePatOnUnauthorized(ctx),
  );
}

/** Org-level adapter (no project binding) for org-wide reads: list projects, profile. */
export async function getUserAzureAdapterOrgLevel(ctx: WorkflowContext): Promise<AzureDevOpsRestAdapter> {
  const pat = await resolveUserAzurePat(ctx.workspace.id, ctx.userId);
  if (!pat) {
    throw new WorkflowAuthError(
      "Add your Azure DevOps Personal Access Token in Settings → My Credentials before running this action.",
      400,
    );
  }
  return new AzureDevOpsRestAdapter(
    { organizationUrl: ctx.workspace.azureOrgUrl, personalAccessToken: pat },
    undefined,
    expirePatOnUnauthorized(ctx),
  );
}

/**
 * Adapter hook that flips the user's PAT to `expired` when Azure rejects it at
 * use-time (401). Fire-and-forget — never blocks or fails the in-flight request.
 */
function expirePatOnUnauthorized(ctx: WorkflowContext): { onUnauthorized: () => void } {
  return {
    onUnauthorized: () => {
      void markUserAzurePatExpired(ctx.workspace.id, ctx.userId).catch(() => {});
    },
  };
}

export async function getUserLLMProvider(ctx: WorkflowContext): Promise<LLMProvider> {
  const llm = await resolveUserLlmConfig(ctx.workspace.id, ctx.userId);
  if (!llm) {
    throw new WorkflowAuthError(
      "Add your LLM provider and API key in Settings → My Credentials before running this action.",
      400,
    );
  }
  // Output cap is a workspace-wide setting (Settings → Workspace), validated to an
  // allowed option at write time; fall back to the deployment default when unset.
  const wsSettings = await getWorkspaceSettings(ctx.workspace.id);
  return createLLMProvider({
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    maxOutputTokenCap: wsSettings?.maxOutputTokenCap ?? getMaxOutputTokenCapDefaultFromEnv(),
    retryAttempts: wsSettings?.llmRetryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
  });
}

/**
 * Maps auth/credential errors to an HTTP response, or null if `error` is not one
 * of them (the route should then fall through to its normal error handling).
 * Call this first in a route's catch block.
 */
export function authErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof SessionError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof WorkflowAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}
