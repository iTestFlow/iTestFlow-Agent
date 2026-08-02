import "server-only";

import { createHash } from "crypto";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { normalizeExpectedWorkItemId } from "./work-item-id";
import {
  createId,
  enqueueBackgroundWrite,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";

export type ProjectKnowledgeBenchmarkSource = "qa" | "business_owner_assistant";

export type ProjectKnowledgeBenchmarkCase = {
  id: string;
  sourceType: ProjectKnowledgeBenchmarkSource;
  question: string;
  usageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  expectedWorkItemId: string | null;
  expectedAnswerSnippet: string | null;
  labeledAt: string | null;
  labeledBy: string | null;
};

type ProjectKnowledgeBenchmarkCaseRow = {
  id: string;
  source_type: ProjectKnowledgeBenchmarkSource;
  sanitized_question: string;
  usage_count: number;
  first_seen_at: string;
  last_seen_at: string;
  expected_work_item_id: string | null;
  expected_answer_snippet: string | null;
  labeled_at: string | null;
  labeled_by: string | null;
};

function toBenchmarkCase(row: ProjectKnowledgeBenchmarkCaseRow): ProjectKnowledgeBenchmarkCase {
  return {
    id: row.id,
    sourceType: row.source_type,
    question: row.sanitized_question,
    usageCount: row.usage_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    expectedWorkItemId: row.expected_work_item_id,
    expectedAnswerSnippet: row.expected_answer_snippet,
    labeledAt: row.labeled_at,
    labeledBy: row.labeled_by,
  };
}

export function sanitizeProjectKnowledgeBenchmarkQuestion(value: string) {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\bhttps?:\/\/[^\s)\]}]+/gi, "[url]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b(?:bearer\s+)?(?:sk|api|token|secret)[-_][a-z0-9_-]{12,}\b/gi, "[secret]")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export function recordProjectKnowledgeBenchmarkQuestion(input: {
  scope: ProjectScope;
  sourceType: ProjectKnowledgeBenchmarkSource;
  question: string;
}) {
  const scope = assertProjectScope(input.scope);
  const sanitized = sanitizeProjectKnowledgeBenchmarkQuestion(input.question);
  if (sanitized.length < 12 || sanitized.split(/\s+/).length < 3) return;
  const questionHash = createHash("sha256").update(sanitized.toLowerCase()).digest("hex");
  const now = nowIso();
  enqueueBackgroundWrite(`knowledge-benchmark:${input.sourceType}`, () => sqlRun(
    `
      INSERT INTO project_knowledge_benchmark_cases (
        id, workspace_id, project_id, azure_project_id, source_type,
        question_hash, sanitized_question, usage_count, first_seen_at, last_seen_at
      ) VALUES (
        @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId,
        @azureProjectId, @sourceType, @questionHash, @sanitizedQuestion, 1, @now, @now
      )
      ON CONFLICT (project_id, azure_project_id, source_type, question_hash)
      DO UPDATE SET usage_count = project_knowledge_benchmark_cases.usage_count + 1,
                    last_seen_at = EXCLUDED.last_seen_at,
                    active = true
    `,
    {
      id: createId("pkbc"),
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: input.sourceType,
      questionHash,
      sanitizedQuestion: sanitized,
      now,
    },
  ));
}

export async function listProjectKnowledgeBenchmarkCases(input: {
  scope: ProjectScope;
  limit?: number;
  /** Restrict to cases an admin has already given an expected work item — the set the runner can score. */
  labeledOnly?: boolean;
}) {
  const scope = assertProjectScope(input.scope);
  const rows = await sqlAll<ProjectKnowledgeBenchmarkCaseRow>(
    `
      SELECT id, source_type, sanitized_question, usage_count, first_seen_at, last_seen_at,
             expected_work_item_id, expected_answer_snippet, labeled_at, labeled_by
      FROM project_knowledge_benchmark_cases
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId AND active = true
        AND (NOT @labeledOnly OR expected_work_item_id IS NOT NULL)
      ORDER BY usage_count DESC, last_seen_at DESC, id
      LIMIT @limit
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      labeledOnly: input.labeledOnly ?? false,
      limit: Math.min(500, Math.max(1, input.limit ?? 500)),
    },
  );
  return rows.map(toBenchmarkCase);
}

/**
 * Records an admin's expected-answer label for a collected benchmark case. Flat
 * overwrite (no history): re-labeling replaces the prior label, and the four
 * columns are always written together so a case is never left with a stale
 * combination (e.g. a new snippet against an old work item id).
 */
export async function labelProjectKnowledgeBenchmarkCase(input: {
  scope: ProjectScope;
  caseId: string;
  expectedWorkItemId?: string | null;
  expectedAnswerSnippet?: string | null;
  labeledBy: string;
}): Promise<ProjectKnowledgeBenchmarkCase> {
  const scope = assertProjectScope(input.scope);
  // Best-effort canonicalization for any future caller; the label API route is the
  // rejection gate for un-normalizable input, so unknown shapes fall back to trimmed.
  const trimmedWorkItemId = input.expectedWorkItemId?.trim() || null;
  const expectedWorkItemId = trimmedWorkItemId
    ? (normalizeExpectedWorkItemId(trimmedWorkItemId) ?? trimmedWorkItemId)
    : null;
  const expectedAnswerSnippet = input.expectedAnswerSnippet?.trim().slice(0, 2000) || null;
  const now = nowIso();
  const row = await sqlGet<ProjectKnowledgeBenchmarkCaseRow>(
    `
      UPDATE project_knowledge_benchmark_cases
      SET expected_work_item_id = @expectedWorkItemId,
          expected_answer_snippet = @expectedAnswerSnippet,
          labeled_at = @now,
          labeled_by = @labeledBy
      WHERE id = @caseId AND project_id = @projectId AND azure_project_id = @azureProjectId AND active = true
      RETURNING id, source_type, sanitized_question, usage_count, first_seen_at, last_seen_at,
                expected_work_item_id, expected_answer_snippet, labeled_at, labeled_by
    `,
    {
      caseId: input.caseId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      expectedWorkItemId,
      expectedAnswerSnippet,
      labeledBy: input.labeledBy,
      now,
    },
  );
  if (!row) {
    throw new AppError({
      code: AppErrorCode.ResourceNotFound,
      message: "Benchmark case was not found in the active project.",
      userMessage: "This benchmark case was not found. Refresh and try again.",
    });
  }
  return toBenchmarkCase(row);
}
