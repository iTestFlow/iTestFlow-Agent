import "server-only";

import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { postBugReportToAzureDevOps } from "@/modules/bug-reporting/bug-posting.service";
import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  createId,
  isPgUniqueViolation,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";

import { getExecutionArtifactStorageBackend } from "./artifact-storage.service";

/**
 * Defect candidates: deterministic drafts generated from failed case runs,
 * reviewed and optionally published through the EXISTING bug-posting service.
 * The publication ledger (test_defect_publications + its partial unique
 * index) supplies the idempotency the repo's bug flow otherwise lacks: at
 * most one non-failed publication per candidate, race-safe, retryable after
 * failure.
 */

const CANDIDATE_OUTCOMES = ["failed_assertion", "timeout"] as const;

/** Called by the worker after a run finalizes; inserts are conflict-tolerant. */
export async function generateDefectCandidatesForRun(runId: string): Promise<number> {
  const failedCases = await sqlAll<{
    id: string;
    run_id: string;
    workspace_id: string;
    project_id: string;
    azure_project_id: string;
    title: string;
    order_index: number;
    outcome: string;
    error_message: string | null;
    story_work_item_id: string | null;
    story_title: string | null;
  }>(
    `SELECT c.id, c.run_id, c.workspace_id, c.project_id, c.azure_project_id, c.title,
            c.order_index, c.outcome, c.error_message, r.story_work_item_id, r.story_title
     FROM test_execution_case_runs c
     JOIN test_execution_runs r ON r.id = c.run_id
     WHERE c.run_id = @runId AND c.outcome = ANY(@outcomes)`,
    { runId, outcomes: [...CANDIDATE_OUTCOMES] },
  );
  let created = 0;
  for (const caseRun of failedCases) {
    const failingStep = await sqlGet<{
      id: string;
      order_index: number;
      action_json: unknown;
      outcome: string;
      error_message: string | null;
      observation_json: { assertion?: { expected: string; actual?: string }; detail?: string } | null;
    }>(
      `SELECT id, order_index, action_json, outcome, error_message, observation_json
       FROM test_execution_step_runs
       WHERE case_run_id = @caseRunId AND outcome NOT IN ('passed', 'not_run', 'skipped')
       ORDER BY order_index ASC LIMIT 1`,
      { caseRunId: caseRun.id },
    );
    const priorSteps = await sqlAll<{ action_json: unknown; order_index: number }>(
      `SELECT action_json, order_index FROM test_execution_step_runs
       WHERE case_run_id = @caseRunId ORDER BY order_index ASC`,
      { caseRunId: caseRun.id },
    );
    const evidence = await sqlAll<{ id: string }>(
      `SELECT id FROM test_execution_artifacts WHERE case_run_id = @caseRunId OR step_run_id = @stepRunId`,
      { caseRunId: caseRun.id, stepRunId: failingStep?.id ?? "" },
    );

    const observation = failingStep?.observation_json ?? null;
    const stepsToReproduce = priorSteps
      .filter((step) => failingStep === undefined || step.order_index <= failingStep.order_index)
      .map((step, index) => `${index + 1}. ${describeActionJson(step.action_json)}`)
      .join("\n");
    const draft = {
      title: `${caseRun.title} — ${caseRun.outcome === "timeout" ? "step timed out" : "failed"} at step ${(failingStep?.order_index ?? 0) + 1}`.slice(0, 140),
      precondition: caseRun.story_work_item_id
        ? `Executing test case "${caseRun.title}" for user story #${caseRun.story_work_item_id}${caseRun.story_title ? ` (${caseRun.story_title})` : ""}.`
        : `Executing test case "${caseRun.title}".`,
      stepsToReproduce: stepsToReproduce || "See the attached execution report.",
      expectedResult: observation?.assertion?.expected ?? "The step completes as written in the test case.",
      actualResult:
        observation?.assertion?.actual !== undefined
          ? `Actual value: ${observation.assertion.actual}`
          : (failingStep?.error_message ?? caseRun.error_message ?? "The step did not complete."),
      severity: "3 - Medium",
      priority: 3,
      systemInfo: "Captured automatically by iTestFlow Test Execution.",
      contextUsed: [],
    };

    const inserted = await sqlRun(
      `INSERT INTO test_defect_candidates (
         id, run_id, case_run_id, workspace_id, project_id, azure_project_id,
         draft_json, evidence_json, created_at, updated_at
       ) VALUES (@id, @runId, @caseRunId, @workspaceId, @projectId, @azureProjectId,
         @draftJson::jsonb, @evidenceJson::jsonb, @now, @now)
       ON CONFLICT (case_run_id) DO NOTHING`,
      {
        id: createId("tdc"),
        runId,
        caseRunId: caseRun.id,
        workspaceId: caseRun.workspace_id,
        projectId: caseRun.project_id,
        azureProjectId: caseRun.azure_project_id,
        draftJson: JSON.stringify(draft),
        evidenceJson: JSON.stringify(
          evidence.map((artifact) => ({ artifactId: artifact.id, stepRunId: failingStep?.id ?? null })),
        ),
        now: nowIso(),
      },
    );
    created += inserted;
  }
  return created;
}

function describeActionJson(actionJson: unknown): string {
  if (!actionJson || typeof actionJson !== "object") return "(step)";
  const action = actionJson as { type?: string; url?: string; text?: string; value?: string; key?: string; expected?: string; locator?: { strategy?: string; role?: string; name?: string; text?: string; value?: string; selector?: string } };
  const locator = action.locator
    ? action.locator.strategy === "role"
      ? `${action.locator.role} "${action.locator.name}"`
      : `"${action.locator.text ?? action.locator.value ?? action.locator.selector ?? ""}"`
    : "";
  switch (action.type) {
    case "navigate": return `Navigate to ${action.url}`;
    case "click": return `Click ${locator}`;
    case "fill": return `Enter a value into ${locator}`;
    case "select": return `Select "${action.value}" in ${locator}`;
    case "check": return `Check ${locator}`;
    case "uncheck": return `Uncheck ${locator}`;
    case "hover": return `Hover over ${locator}`;
    case "pressKey": return `Press ${action.key}`;
    case "waitFor": return "Wait for the page to update";
    case "assertVisible": return `Verify ${locator} is visible`;
    case "assertHidden": return `Verify ${locator} is hidden`;
    case "assertText": return `Verify the page shows "${action.text}"`;
    case "assertUrl": return `Verify the URL ${action.expected ? `contains "${action.expected}"` : "is correct"}`;
    case "assertValue": return `Verify the value of ${locator}`;
    case "screenshot": return "Capture a screenshot";
    default: return `(${action.type ?? "step"})`;
  }
}

type CandidateRow = {
  id: string;
  run_id: string;
  case_run_id: string;
  status: string;
  draft_json: Record<string, unknown>;
  evidence_json: { artifactId: string }[];
  story_work_item_id: string | null;
};

async function loadCandidate(input: {
  workspaceId: string;
  scope: ProjectScope;
  candidateId: string;
}): Promise<CandidateRow | null> {
  const row = await sqlGet<CandidateRow>(
    `SELECT c.id, c.run_id, c.case_run_id, c.status, c.draft_json, c.evidence_json, r.story_work_item_id
     FROM test_defect_candidates c
     JOIN test_execution_runs r ON r.id = c.run_id
     WHERE c.id = @candidateId AND c.workspace_id = @workspaceId
       AND c.project_id = @projectId AND c.azure_project_id = @azureProjectId`,
    {
      candidateId: input.candidateId,
      workspaceId: input.workspaceId,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
    },
  );
  return row ?? null;
}

export async function updateDefectCandidate(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  candidateId: string;
  status?: "proposed" | "selected" | "dismissed";
  draft?: Record<string, unknown>;
}): Promise<boolean> {
  const candidate = await loadCandidate(input);
  if (!candidate) return false;
  if (candidate.status === "published") {
    throw new CandidateAlreadyPublishedError(null);
  }
  const nextDraft = input.draft ? { ...candidate.draft_json, ...input.draft } : candidate.draft_json;
  await sqlRun(
    `UPDATE test_defect_candidates
     SET status = @status, draft_json = @draftJson::jsonb, updated_at = @now, updated_by = @actor
     WHERE id = @candidateId AND status <> 'published'`,
    {
      candidateId: input.candidateId,
      status: input.status ?? candidate.status,
      draftJson: JSON.stringify(nextDraft),
      actor: input.actor,
      now: nowIso(),
    },
  );
  return true;
}

export class CandidateAlreadyPublishedError extends Error {
  constructor(readonly azureBugId: string | null) {
    super("This defect candidate has already been published.");
    this.name = "CandidateAlreadyPublishedError";
  }
}

export class CandidatePublishInProgressError extends Error {
  constructor() {
    super("A publication for this candidate is already in progress.");
    this.name = "CandidatePublishInProgressError";
  }
}

export async function publishDefectCandidate(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  adapter: AzureDevOpsAdapter;
  candidateId: string;
}): Promise<{ azureBugId: string; azureBugUrl: string }> {
  const candidate = await loadCandidate(input);
  if (!candidate) throw new CandidateNotFoundError();
  if (candidate.status === "published") {
    const existing = await sqlGet<{ azure_bug_id: string | null }>(
      `SELECT azure_bug_id FROM test_defect_publications
       WHERE candidate_id = @candidateId AND status = 'succeeded'`,
      { candidateId: candidate.id },
    );
    throw new CandidateAlreadyPublishedError(existing?.azure_bug_id ?? null);
  }

  // Idempotency lock: the partial unique index admits one non-failed row.
  const publicationId = createId("tpub");
  const now = nowIso();
  try {
    await sqlRun(
      `INSERT INTO test_defect_publications (
         id, candidate_id, workspace_id, project_id, azure_project_id,
         status, published_by, created_at, updated_at
       ) VALUES (@id, @candidateId, @workspaceId, @projectId, @azureProjectId,
         'publishing', @actor, @now, @now)`,
      {
        id: publicationId,
        candidateId: candidate.id,
        workspaceId: input.workspaceId,
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
        actor: input.actor,
        now,
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await sqlGet<{ status: string; azure_bug_id: string | null }>(
        `SELECT status, azure_bug_id FROM test_defect_publications
         WHERE candidate_id = @candidateId AND status <> 'failed'`,
        { candidateId: candidate.id },
      );
      if (existing?.status === "succeeded") throw new CandidateAlreadyPublishedError(existing.azure_bug_id);
      throw new CandidatePublishInProgressError();
    }
    throw error;
  }

  try {
    const attachments = await collectEvidenceAttachments(candidate);
    const result = await postBugReportToAzureDevOps({
      adapter: input.adapter,
      scope: input.scope,
      actor: input.actor,
      report: candidate.draft_json,
      parentStoryId: candidate.story_work_item_id ?? undefined,
      attachments,
    });
    await sqlRun(
      `UPDATE test_defect_publications
       SET status = 'succeeded', azure_bug_id = @azureBugId, azure_bug_url = @azureBugUrl,
           attachment_results_json = @attachmentResults::jsonb, updated_at = @now
       WHERE id = @publicationId`,
      {
        publicationId,
        azureBugId: result.bugId,
        azureBugUrl: result.webUrl,
        attachmentResults: JSON.stringify(result.attachmentResults),
        now: nowIso(),
      },
    );
    await sqlRun(
      `UPDATE test_defect_candidates SET status = 'published', updated_at = @now, updated_by = @actor
       WHERE id = @candidateId`,
      { candidateId: candidate.id, actor: input.actor, now: nowIso() },
    );
    writeAuditLog({
      workspaceId: input.workspaceId,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
      azureOrganizationUrl: input.scope.azureOrganizationUrl,
      entityType: "test_defect_candidate",
      entityId: candidate.id,
      action: "test_execution.defect_published",
      status: "Success",
      actor: input.actor,
      message: `Defect candidate published as Azure DevOps Bug ${result.bugId}.`,
      details: { runId: candidate.run_id, caseRunId: candidate.case_run_id, azureBugId: result.bugId },
    });
    return { azureBugId: result.bugId, azureBugUrl: result.webUrl };
  } catch (error) {
    await sqlRun(
      `UPDATE test_defect_publications
       SET status = 'failed', error_message = @message, updated_at = @now
       WHERE id = @publicationId`,
      {
        publicationId,
        message: (error instanceof Error ? error.message : "Publish failed.").slice(0, 500),
        now: nowIso(),
      },
    );
    throw error;
  }
}

export class CandidateNotFoundError extends Error {
  constructor() {
    super("The defect candidate was not found.");
    this.name = "CandidateNotFoundError";
  }
}

const MAX_ATTACHMENTS = 5;

async function collectEvidenceAttachments(candidate: CandidateRow) {
  const artifactIds = candidate.evidence_json
    .map((entry) => entry.artifactId)
    .filter(Boolean)
    .slice(0, MAX_ATTACHMENTS);
  if (artifactIds.length === 0) return [];
  const rows = await sqlAll<{ id: string; storage_key: string; mime_type: string; file_name: string }>(
    `SELECT id, storage_key, mime_type, file_name FROM test_execution_artifacts WHERE id = ANY(@artifactIds)`,
    { artifactIds },
  );
  const backend = getExecutionArtifactStorageBackend();
  const attachments = [];
  for (const row of rows) {
    try {
      const stream = await backend.getStream({ storageKey: row.storage_key });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      attachments.push({
        fileName: `${row.id}-${row.file_name}`,
        contentType: row.mime_type,
        content: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      });
    } catch {
      // Evidence attachment is best-effort; the bug still publishes without it.
    }
  }
  return attachments;
}

function isUniqueViolation(error: unknown): boolean {
  return isPgUniqueViolation(error);
}
