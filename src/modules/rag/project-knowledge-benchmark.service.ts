import "server-only";

import { createHash } from "crypto";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  createId,
  enqueueBackgroundWrite,
  nowIso,
  sqlAll,
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
};

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

export async function submitProjectKnowledgeBenchmarkQuestion(input: {
  scope: ProjectScope;
  question: string;
}) {
  const scope = assertProjectScope(input.scope);
  const sanitized = sanitizeProjectKnowledgeBenchmarkQuestion(input.question);
  if (sanitized.length < 12 || sanitized.split(/\s+/).length < 3) {
    throw new Error("Benchmark questions must contain at least three meaningful words.");
  }
  const questionHash = createHash("sha256").update(sanitized.toLowerCase()).digest("hex");
  const now = nowIso();
  await sqlRun(
    `
      INSERT INTO project_knowledge_benchmark_cases (
        id, workspace_id, project_id, azure_project_id, source_type,
        question_hash, sanitized_question, usage_count, first_seen_at, last_seen_at
      ) VALUES (
        @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId,
        @azureProjectId, 'qa', @questionHash, @sanitizedQuestion, 1, @now, @now
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
      questionHash,
      sanitizedQuestion: sanitized,
      now,
    },
  );
  return { sourceType: "qa" as const, question: sanitized };
}

export async function listProjectKnowledgeBenchmarkCases(input: {
  scope: ProjectScope;
  limit?: number;
}) {
  const scope = assertProjectScope(input.scope);
  const rows = await sqlAll<{
    id: string;
    source_type: ProjectKnowledgeBenchmarkSource;
    sanitized_question: string;
    usage_count: number;
    first_seen_at: string;
    last_seen_at: string;
  }>(
    `
      SELECT id, source_type, sanitized_question, usage_count, first_seen_at, last_seen_at
      FROM project_knowledge_benchmark_cases
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId AND active = true
      ORDER BY usage_count DESC, last_seen_at DESC, id
      LIMIT @limit
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      limit: Math.min(500, Math.max(1, input.limit ?? 500)),
    },
  );
  return rows.map((row): ProjectKnowledgeBenchmarkCase => ({
    id: row.id,
    sourceType: row.source_type,
    question: row.sanitized_question,
    usageCount: row.usage_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}
