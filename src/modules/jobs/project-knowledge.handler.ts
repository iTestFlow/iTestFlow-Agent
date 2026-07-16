import "server-only";

import { z } from "zod";

import { resolveUserLlmConfig } from "@/modules/credentials/credential.service";
import { DEFAULT_RETRY_ATTEMPTS, getMaxOutputTokenCapDefaultFromEnv } from "@/modules/llm/llm-defaults";
import { createLLMProvider } from "@/modules/llm/llm-provider.factory";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  applyProjectKnowledgeConflictDecisions,
  publishProjectKnowledgeDraft,
  type ProjectKnowledgeDraft,
} from "@/modules/rag/project-knowledge-draft.service";
import {
  previewGeneratedProjectKnowledgeBase,
  saveManualProjectKnowledgeBaseFromBatches,
} from "@/modules/rag/project-knowledge.service";
import { sqlGet } from "@/modules/shared/infrastructure/database/db";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import type { JobHandler } from "./job-handlers";
import { completeJobBatch, loadCompletedJobBatch } from "./job-queue.service";
import {
  PROJECT_KNOWLEDGE_JOB,
  ProjectKnowledgeConflictDecisionSchema,
  ProjectKnowledgeJobOperationSchema,
} from "./project-knowledge-jobs.service";

export { PROJECT_KNOWLEDGE_JOB };

const PayloadSchema = z.object({
  projectId: z.string().min(1),
  operation: ProjectKnowledgeJobOperationSchema,
  mode: z.enum(["incremental", "full"]).optional(),
  draftId: z.string().min(1).optional(),
  draftVersion: z.string().min(1).optional(),
  decisions: z.array(ProjectKnowledgeConflictDecisionSchema).optional(),
});

export const runProjectKnowledgeJob: JobHandler = async (job, context) => {
  if (!job.workspaceId || !job.createdByUserId) {
    throw new Error("A project knowledge job requires its initiating user and workspace.");
  }
  const payload = PayloadSchema.parse(job.payload);
  const scope = await loadProjectScope(job.workspaceId, payload.projectId);
  context.signal.throwIfAborted();

  switch (payload.operation) {
    case "build": {
      await context.updateProgress({
        phase: "resolving_ai_credentials",
        percent: 5,
        operation: payload.operation,
        ...(typeof job.progress?.draftId === "string" ? { draftId: job.progress.draftId } : {}),
      });
      const provider = await loadInitiatingUserProvider(job.workspaceId, job.createdByUserId);
      const draft = await previewGeneratedProjectKnowledgeBase({
        scope,
        actor: job.createdByUserId,
        provider,
        mode: payload.mode ?? "incremental",
        signal: context.signal,
        existingDraftId: typeof job.progress?.draftId === "string" ? job.progress.draftId : undefined,
        preserveDraftOnError: job.attempts < job.maxAttempts,
        batchCache: {
          load: (batchIndex) => loadCompletedJobBatch(job.id, `extraction:${batchIndex}`),
          save: (batchIndex, result) => completeJobBatch({
            jobId: job.id,
            batchKey: `extraction:${batchIndex}`,
            result,
          }),
        },
        onProgress: async (progress) => {
          const percent = progress.phase === "loading_frozen_sources"
            ? 10
            : progress.phase === "preparing_frozen_build"
              ? 18
              : progress.phase === "validating_citations"
                ? 82
                : progress.total
                  ? 20 + Math.round(((progress.completed ?? 0) / progress.total) * 58)
                  : 20;
          await context.updateProgress({ ...progress, percent, operation: payload.operation });
        },
      });
      await context.updateProgress({
        phase: draft.draftStatus === "blocked" ? "conflicts_required" : "ready_to_publish",
        percent: 95,
        operation: payload.operation,
        draftId: draft.draftId,
      });
      return {
        outcome: draft.alreadyCurrent
          ? "no_changes"
          : draft.draftStatus === "blocked"
            ? "conflicts_required"
            : "ready_to_publish",
        draftId: draft.draftId,
        draftStatus: draft.draftStatus,
        conflictCount: draft.blockers.filter((blocker) => blocker.type === "hard_conflict").length,
        omittedEntryCount: draft.omittedEntryCount,
        omissionReasons: draft.omissionReasons,
        warnings: draft.warnings ?? [],
      };
    }
    case "manual_finalize": {
      if (!payload.draftId) throw new Error("manual_finalize requires draftId.");
      await context.updateProgress({ phase: "loading_validated_batches", percent: 20, operation: payload.operation, draftId: payload.draftId });
      context.signal.throwIfAborted();
      const draft = await saveManualProjectKnowledgeBaseFromBatches({
        scope,
        actor: job.createdByUserId,
        draftId: payload.draftId,
        mode: payload.mode ?? "full",
        partialKnowledgeBases: [],
      });
      return draftSummary(draft);
    }
    case "apply_decisions": {
      if (!payload.draftId || !payload.draftVersion || !payload.decisions) {
        throw new Error("apply_decisions requires draftId, draftVersion, and decisions.");
      }
      await context.updateProgress({ phase: "applying_decisions", percent: 25, operation: payload.operation, draftId: payload.draftId });
      context.signal.throwIfAborted();
      const draft = await applyProjectKnowledgeConflictDecisions({
        scope,
        actor: job.createdByUserId,
        draftId: payload.draftId,
        draftVersion: payload.draftVersion,
        decisions: payload.decisions,
      });
      return draftSummary(draft);
    }
    case "publish": {
      if (!payload.draftId) throw new Error("publish requires draftId.");
      await context.updateProgress({ phase: "committing_publication", percent: 35, operation: payload.operation, draftId: payload.draftId });
      context.signal.throwIfAborted();
      const draft = await publishProjectKnowledgeDraft({
        scope,
        actor: job.createdByUserId,
        draftId: payload.draftId,
      });
      if (!draft) throw new Error("Publish completed without a persisted draft result.");
      if (draft.persistedStatus === "superseded") {
        return {
          outcome: "outdated",
          draftId: draft.id,
          draftStatus: draft.persistedStatus,
          message: "Another administrator published a different revision. Start a new build from the latest publication.",
        };
      }
      const freshness = draft.pendingDrift ? "stale" : "current";
      return {
        outcome: "published",
        draftId: draft.id,
        draftStatus: draft.persistedStatus,
        freshness,
        message: freshness === "stale"
          ? "Newer source updates will be included in the next build."
          : "Published the exact reviewed draft.",
      };
    }
  }
};

async function loadProjectScope(workspaceId: string, projectId: string): Promise<ProjectScope> {
  const project = await sqlGet<{
    azure_project_id: string;
    azure_project_name: string;
    azure_organization_url: string;
  }>(
    `SELECT azure_project_id, azure_project_name, azure_organization_url
     FROM projects WHERE id = @projectId AND workspace_id = @workspaceId LIMIT 1`,
    { projectId, workspaceId },
  );
  if (!project) throw new Error("The project knowledge job project was not found in its workspace.");
  return {
    projectId,
    workspaceId,
    azureProjectId: project.azure_project_id,
    azureProjectName: project.azure_project_name,
    azureOrganizationUrl: project.azure_organization_url,
  };
}

async function loadInitiatingUserProvider(workspaceId: string, userId: string) {
  const llm = await resolveUserLlmConfig(workspaceId, userId);
  if (!llm) throw new Error("The initiating user no longer has an LLM provider configured.");
  const settings = await getWorkspaceSettings(workspaceId);
  return createLLMProvider({
    provider: llm.provider,
    apiKey: llm.apiKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    maxInputTokens: llm.maxInputTokens,
    maxOutputTokenCap: settings?.maxOutputTokenCap ?? getMaxOutputTokenCapDefaultFromEnv(),
    retryAttempts: settings?.llmRetryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
  });
}

function draftSummary(draft: ProjectKnowledgeDraft) {
  return {
    outcome: draft.persistedStatus === "blocked" ? "conflicts_required" : "ready_to_publish",
    draftId: draft.id,
    draftStatus: draft.persistedStatus,
    conflictCount: draft.blockers.filter((blocker) => blocker.type === "hard_conflict").length,
    omittedEntryCount: Number(draft.metrics.omittedEntryCount ?? 0),
    omissionReasons: draft.metrics.omissionReasons ?? {},
  };
}
