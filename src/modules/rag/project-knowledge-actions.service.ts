import "server-only";

import type { z } from "zod";

import {
  assertNoActiveProjectKnowledgeBuild,
  withProjectKnowledgeOperationGate,
} from "@/modules/jobs/project-knowledge-operation-gate";
import type { ProjectKnowledgeConflictDecisionSchema } from "@/modules/jobs/project-knowledge-jobs.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  applyProjectKnowledgeConflictDecisions,
  publishProjectKnowledgeDraft,
  type ProjectKnowledgeDraft,
} from "./project-knowledge-draft.service";
import { saveManualProjectKnowledgeBaseFromBatches } from "./project-knowledge.service";

export async function finalizeManualProjectKnowledge(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
  mode: "incremental" | "full";
}) {
  return runSynchronousAction(input.scope, "manual_finalize", async () => {
    const draft = await saveManualProjectKnowledgeBaseFromBatches({
      scope: input.scope,
      actor: input.actor,
      draftId: input.draftId,
      mode: input.mode,
      partialKnowledgeBases: [],
    });
    return projectKnowledgeDraftSummary(draft);
  });
}

export async function applyKnowledgeConflictDecisions(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
  draftVersion: string;
  decisions: z.infer<typeof ProjectKnowledgeConflictDecisionSchema>[];
}) {
  return runSynchronousAction(input.scope, "apply_decisions", async () => {
    const draft = await applyProjectKnowledgeConflictDecisions(input);
    return projectKnowledgeDraftSummary(draft);
  });
}

export async function publishReviewedProjectKnowledge(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
}) {
  return runSynchronousAction(input.scope, "publish", async () => {
    const draft = await publishProjectKnowledgeDraft(input);
    if (!draft) throw new Error("Publish completed without a persisted draft result.");
    if (draft.persistedStatus === "superseded") {
      return {
        outcome: "outdated" as const,
        draftId: draft.id,
        draftStatus: draft.persistedStatus,
        message: "Another administrator published a different revision. Start a new build from the latest publication.",
      };
    }
    const freshness = draft.pendingDrift ? "stale" as const : "current" as const;
    return {
      outcome: "published" as const,
      draftId: draft.id,
      draftStatus: draft.persistedStatus,
      freshness,
      message: freshness === "stale"
        ? "Newer source updates will be included in the next build."
        : "Published the exact reviewed draft.",
    };
  });
}

export function projectKnowledgeDraftSummary(draft: ProjectKnowledgeDraft) {
  return {
    outcome: draft.persistedStatus === "blocked" ? "conflicts_required" as const : "ready_to_publish" as const,
    draftId: draft.id,
    draftStatus: draft.persistedStatus,
    conflictCount: draft.blockers.filter((blocker) => blocker.type === "hard_conflict").length,
    possibleTensionCount: Number(draft.metrics.possibleTensionCount ?? 0),
    omittedEntryCount: Number(draft.metrics.omittedEntryCount ?? 0),
    omissionReasons: draft.metrics.omissionReasons ?? {},
  };
}

async function runSynchronousAction<T>(
  scope: ProjectScope,
  operation: string,
  action: () => Promise<T>,
) {
  return withProjectKnowledgeOperationGate(scope, operation, async () => {
    await assertNoActiveProjectKnowledgeBuild(scope);
    return action();
  });
}
