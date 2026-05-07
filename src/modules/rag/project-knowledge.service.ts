import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider, LLMResult } from "@/modules/llm/llm-types";
import {
  projectKnowledgeConsolidationPrompt,
  projectKnowledgeExtractionPrompt,
} from "@/modules/llm/prompts";
import { createId, getDatabase, nowIso } from "@/modules/shared/infrastructure/database/db";
import {
  PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";

const MAX_CONTEXT_INPUT_CHARS = 60000;

type ProjectKnowledgeWorkItemRow = {
  azure_work_item_id: string;
  work_item_type: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  state: string | null;
  tags: string | null;
  area_path: string | null;
  iteration_path: string | null;
  updated_date: string | null;
};

type ProjectKnowledgeWorkItem = {
  id: string;
  workItemType: string;
  title: string;
  state?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string[];
  areaPath?: string;
  iterationPath?: string;
  updatedDate?: string;
};

type ProjectKnowledgeSnapshotRow = {
  id: string;
  prompt_version: string;
  provider: string | null;
  model_name: string | null;
  source_work_item_count: number;
  raw_output: string | null;
  validated_output: string;
  status: string;
  error_details: string | null;
  extracted_at: string;
  created_at: string;
  updated_at: string;
};

export type ProjectKnowledgeSnapshot = {
  id: string;
  promptVersion: string;
  provider?: string | null;
  model?: string | null;
  sourceWorkItemCount: number;
  rawOutput?: string | null;
  knowledgeBase: ProjectKnowledgeBase;
  status: string;
  errorDetails?: string | null;
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
};

export async function extractAndSaveProjectKnowledgeBase(input: {
  scope: ProjectScope;
  provider: LLMProvider;
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }

  const result = await extractProjectKnowledgeBase({
    scope,
    provider: input.provider,
    workItems,
  });
  const snapshot = saveProjectKnowledgeBaseSnapshot({
    scope,
    provider: result.provider,
    model: result.model,
    rawOutput: result.rawOutput,
    knowledgeBase: result.validatedOutput,
    sourceWorkItemCount: workItems.length,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "rag.extract_project_knowledge_base",
    status: "Success",
    message: "Extracted and saved project knowledge base from indexed context.",
    details: {
      provider: result.provider,
      model: result.model,
      promptVersion: projectKnowledgeExtractionPrompt.version,
      sourceWorkItemCount: workItems.length,
      counts: getKnowledgeCounts(result.validatedOutput),
    },
  });

  return snapshot;
}

export function getProjectKnowledgeBaseSnapshot(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const row = db
    .prepare(
      `
      SELECT id, prompt_version, provider, model_name, source_work_item_count,
             raw_output, validated_output, status, error_details,
             extracted_at, created_at, updated_at
      FROM project_knowledge_base
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    )
    .get({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as ProjectKnowledgeSnapshotRow | undefined;

  return row ? toProjectKnowledgeSnapshot(row) : null;
}

export function getSavedProjectKnowledgeBase(input: { scope: ProjectScope }) {
  return getProjectKnowledgeBaseSnapshot(input)?.knowledgeBase ?? null;
}

async function extractProjectKnowledgeBase(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  workItems: ProjectKnowledgeWorkItem[];
}): Promise<LLMResult<ProjectKnowledgeBase>> {
  const batches = buildWorkItemBatches(input.workItems);
  if (batches.length === 1) {
    return extractProjectKnowledgeBatch({
      scope: input.scope,
      provider: input.provider,
      workItems: batches[0],
    });
  }

  const partialResults = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batchResult = await extractProjectKnowledgeBatch({
      scope: input.scope,
      provider: input.provider,
      workItems: batches[index],
      batchIndex: index + 1,
      batchCount: batches.length,
    });
    partialResults.push(batchResult);
  }

  const consolidated = await input.provider.generateStructuredOutput({
    schemaName: "ProjectKnowledgeBase",
    schema: ProjectKnowledgeBaseSchema,
    system: projectKnowledgeConsolidationPrompt.system,
    user: JSON.stringify({
      requiredOutputShape: PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
      partialKnowledgeBases: partialResults.map((result) => result.validatedOutput),
      projectScope: {
        azureProjectId: input.scope.azureProjectId,
        azureProjectName: input.scope.azureProjectName,
      },
    }),
    maxTokens: 20000,
  });

  return {
    ...consolidated,
    rawOutput: JSON.stringify({
      batches: partialResults.map((result) => result.rawOutput),
      consolidation: consolidated.rawOutput,
    }),
  };
}

async function extractProjectKnowledgeBatch(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  workItems: ProjectKnowledgeWorkItem[];
  batchIndex?: number;
  batchCount?: number;
}) {
  return input.provider.generateStructuredOutput({
    schemaName: "ProjectKnowledgeBase",
    schema: ProjectKnowledgeBaseSchema,
    system: projectKnowledgeExtractionPrompt.system,
    user: JSON.stringify({
      requiredOutputShape: PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
      extractionMode: input.batchCount ? "batch" : "full",
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
      workItems: input.workItems,
      projectScope: {
        azureProjectId: input.scope.azureProjectId,
        azureProjectName: input.scope.azureProjectName,
      },
    }),
    maxTokens: 20000,
  });
}

function loadProjectKnowledgeWorkItems(scope: ProjectScope): ProjectKnowledgeWorkItem[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
      SELECT azure_work_item_id, work_item_type, title, description,
             acceptance_criteria, state, tags, area_path, iteration_path, updated_date
      FROM azure_devops_work_items
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY work_item_type ASC, azure_work_item_id ASC
    `,
    )
    .all({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as ProjectKnowledgeWorkItemRow[];

  return rows.map((row) => ({
    id: row.azure_work_item_id,
    workItemType: row.work_item_type,
    title: row.title,
    state: row.state ?? undefined,
    description: row.description ? stripHtml(row.description) : undefined,
    acceptanceCriteria: row.acceptance_criteria ? stripHtml(row.acceptance_criteria) : undefined,
    tags: parseTags(row.tags),
    areaPath: row.area_path ?? undefined,
    iterationPath: row.iteration_path ?? undefined,
    updatedDate: row.updated_date ?? undefined,
  }));
}

function saveProjectKnowledgeBaseSnapshot(input: {
  scope: ProjectScope;
  provider: string;
  model: string;
  rawOutput: string;
  knowledgeBase: ProjectKnowledgeBase;
  sourceWorkItemCount: number;
}) {
  const db = getDatabase();
  const now = nowIso();
  const id = createId("pkb");
  const validatedOutput = JSON.stringify(input.knowledgeBase);

  try {
    db.exec("BEGIN");
    db
      .prepare(
        `
        DELETE FROM project_knowledge_base
        WHERE project_id = @projectId
          AND azure_project_id = @azureProjectId
      `,
      )
      .run({
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
      });
    db
      .prepare(
        `
        INSERT INTO project_knowledge_base (
          id, project_id, azure_project_id, azure_project_name, azure_organization_url,
          prompt_version, provider, model_name, source_work_item_count, raw_output,
          validated_output, status, error_details, extracted_at, created_at, updated_at
        ) VALUES (
          @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
          @promptVersion, @provider, @model, @sourceWorkItemCount, @rawOutput,
          @validatedOutput, 'Success', NULL, @extractedAt, @createdAt, @updatedAt
        )
      `,
      )
      .run({
        id,
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
        azureProjectName: input.scope.azureProjectName,
        azureOrganizationUrl: input.scope.azureOrganizationUrl,
        promptVersion: projectKnowledgeExtractionPrompt.version,
        provider: input.provider,
        model: input.model,
        sourceWorkItemCount: input.sourceWorkItemCount,
        rawOutput: input.rawOutput,
        validatedOutput,
        extractedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    id,
    promptVersion: projectKnowledgeExtractionPrompt.version,
    provider: input.provider,
    model: input.model,
    sourceWorkItemCount: input.sourceWorkItemCount,
    rawOutput: input.rawOutput,
    knowledgeBase: input.knowledgeBase,
    status: "Success",
    errorDetails: null,
    extractedAt: now,
    createdAt: now,
    updatedAt: now,
  } satisfies ProjectKnowledgeSnapshot;
}

function buildWorkItemBatches(workItems: ProjectKnowledgeWorkItem[]) {
  const batches: ProjectKnowledgeWorkItem[][] = [];
  let current: ProjectKnowledgeWorkItem[] = [];
  let currentChars = 0;

  workItems.forEach((item) => {
    const itemChars = JSON.stringify(item).length;
    if (current.length && currentChars + itemChars > MAX_CONTEXT_INPUT_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  });

  if (current.length) batches.push(current);
  return batches.length ? batches : [[]];
}

function toProjectKnowledgeSnapshot(row: ProjectKnowledgeSnapshotRow): ProjectKnowledgeSnapshot {
  return {
    id: row.id,
    promptVersion: row.prompt_version,
    provider: row.provider,
    model: row.model_name,
    sourceWorkItemCount: row.source_work_item_count,
    rawOutput: row.raw_output,
    knowledgeBase: ProjectKnowledgeBaseSchema.parse(JSON.parse(row.validated_output)),
    status: row.status,
    errorDetails: row.error_details,
    extractedAt: row.extracted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getKnowledgeCounts(knowledgeBase: ProjectKnowledgeBase) {
  return {
    modules: knowledgeBase.modules.length,
    businessRules: knowledgeBase.businessRules.length,
    stateTransitions: knowledgeBase.stateTransitions.length,
    glossary: knowledgeBase.glossary.length,
    crossDependencies: knowledgeBase.crossDependencies.length,
  };
}

function parseTags(value: string | null) {
  if (!value) return undefined;
  const tags = value
    .split(";")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
