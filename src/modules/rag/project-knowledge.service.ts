import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider, LLMResult } from "@/modules/llm/llm-types";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
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
import { refreshProjectKnowledgeSearchIndex } from "./context-chatbot-retrieval.service";
import {
  recordProjectKnowledgeRevision,
  runProjectKnowledgeLint,
  type ProjectKnowledgeCompilationMode,
} from "./project-knowledge-compiled.service";
import { ensureProjectContextSyncSchema } from "./project-context-schema.service";

const MAX_CONTEXT_INPUT_CHARS = 30000;
const GLOSSARY_TYPE_PRIORITY: Record<ProjectKnowledgeBase["glossary"][number]["type"], number> = {
  business_entity: 1,
  process: 2,
  role: 3,
  actor: 4,
  external_service: 5,
  system: 6,
  data_entity: 7,
  term: 8,
};

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
  mode?: Extract<ProjectKnowledgeCompilationMode, "incremental" | "full">;
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
    mode: input.mode ?? "incremental",
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

export function buildProjectKnowledgeManualDraft(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  const workItems = loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }

  const batches = buildWorkItemBatches(workItems);

  return {
    schemaName: "ProjectKnowledgeBase",
    promptName: projectKnowledgeExtractionPrompt.name,
    promptVersion: projectKnowledgeExtractionPrompt.version,
    sourceWorkItemCount: workItems.length,
    batchCount: batches.length,
    batches: batches.map((batch, index) => {
      const batchIndex = index + 1;
      const batchMetadata = batches.length > 1 ? { batchIndex, batchCount: batches.length } : {};
      const userPrompt = buildProjectKnowledgeExtractionUserPrompt({
        scope,
        workItems: batch,
        ...batchMetadata,
      });

      return {
        batchIndex,
        batchCount: batches.length,
        workItemCount: batch.length,
        systemPrompt: projectKnowledgeExtractionPrompt.system,
        userPrompt,
        prompt: buildManualPromptMarkdown({
          title: batches.length > 1
            ? `iTestFlow Knowledge Base Extraction - Batch ${batchIndex} of ${batches.length}`
            : "iTestFlow Knowledge Base Extraction",
          system: projectKnowledgeExtractionPrompt.system,
          user: userPrompt,
        }),
      };
    }),
  };
}

export function buildProjectKnowledgeManualConsolidationPrompt(input: {
  scope: ProjectScope;
  partialKnowledgeBases: ProjectKnowledgeBase[];
}) {
  const scope = assertProjectScope(input.scope);
  const userPrompt = buildProjectKnowledgeConsolidationUserPrompt({
    scope,
    partialKnowledgeBases: input.partialKnowledgeBases,
  });

  return {
    schemaName: "ProjectKnowledgeBase",
    promptName: projectKnowledgeConsolidationPrompt.name,
    promptVersion: projectKnowledgeConsolidationPrompt.version,
    systemPrompt: projectKnowledgeConsolidationPrompt.system,
    userPrompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Knowledge Base Consolidation",
      system: projectKnowledgeConsolidationPrompt.system,
      user: userPrompt,
    }),
  };
}

export function validateProjectKnowledgeExternalOutput(rawOutput: string) {
  return parseExternalStructuredOutput({
    schemaName: "ProjectKnowledgeBase",
    schema: ProjectKnowledgeBaseSchema,
    rawOutput,
  });
}

export function saveManualProjectKnowledgeBaseSnapshot(input: {
  scope: ProjectScope;
  rawOutput: string;
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }

  const knowledgeBase = validateProjectKnowledgeExternalOutput(input.rawOutput);
  const snapshot = saveProjectKnowledgeBaseSnapshot({
    scope,
    provider: "external",
    model: "manual-external",
    rawOutput: input.rawOutput,
    knowledgeBase,
    sourceWorkItemCount: workItems.length,
    mode: "manual",
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "rag.extract_project_knowledge_base.manual_complete",
    status: "Success",
    message: "Extracted and saved project knowledge base from validated external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: projectKnowledgeExtractionPrompt.version,
      sourceWorkItemCount: workItems.length,
      counts: getKnowledgeCounts(knowledgeBase),
    },
  });

  return snapshot;
}

export function saveManualProjectKnowledgeBaseFromBatches(input: {
  scope: ProjectScope;
  partialKnowledgeBases: ProjectKnowledgeBase[];
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }
  if (!input.partialKnowledgeBases.length) {
    throw new Error("Validate at least one batch response before saving the knowledge base.");
  }

  const knowledgeBase = consolidateProjectKnowledgeBases(input.partialKnowledgeBases);
  const rawOutput = JSON.stringify({
    consolidationMode: "local-deterministic",
    partialKnowledgeBases: input.partialKnowledgeBases,
    consolidatedKnowledgeBase: knowledgeBase,
  });
  const snapshot = saveProjectKnowledgeBaseSnapshot({
    scope,
    provider: "external",
    model: "manual-external",
    rawOutput,
    knowledgeBase,
    sourceWorkItemCount: workItems.length,
    mode: "manual",
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "rag.extract_project_knowledge_base.manual_batch_complete",
    status: "Success",
    message: "Extracted and saved project knowledge base from locally consolidated external LLM batch output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: projectKnowledgeExtractionPrompt.version,
      sourceWorkItemCount: workItems.length,
      batchCount: input.partialKnowledgeBases.length,
      counts: getKnowledgeCounts(knowledgeBase),
    },
  });

  return snapshot;
}

function consolidateProjectKnowledgeBases(partialKnowledgeBases: ProjectKnowledgeBase[]) {
  const merged = {
    modules: mergeItems(
      partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.modules),
      (item) => [`id:${normalizeKey(item.id)}`, `name:${normalizeKey(item.name)}`],
      (first, second) => ({
        ...first,
        name: first.name || second.name,
        description: chooseLongerText(first.description, second.description),
        sourceWorkItemIds: mergeUnique(first.sourceWorkItemIds, second.sourceWorkItemIds),
        evidence: mergeEvidence(first.evidence, second.evidence),
      }),
    ),
    businessRules: mergeItems(
      partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.businessRules),
      (item) => [`id:${normalizeKey(item.id)}`, `rule:${normalizeKey(item.rule)}`],
      (first, second) => ({
        ...first,
        rule: chooseLongerText(first.rule, second.rule),
        moduleName: first.moduleName ?? second.moduleName,
        sourceField: first.sourceField || second.sourceField,
        sourceWorkItemIds: mergeUnique(first.sourceWorkItemIds, second.sourceWorkItemIds),
        evidence: mergeEvidence(first.evidence, second.evidence),
      }),
    ),
    stateTransitions: mergeItems(
      partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.stateTransitions),
      (item) => [
        `id:${normalizeKey(item.id)}`,
        `transition:${normalizeKey([item.workflowName, item.fromState, item.toState, item.triggerOrCondition].filter(Boolean).join(" "))}`,
      ],
      (first, second) => ({
        ...first,
        workflowName: first.workflowName || second.workflowName,
        fromState: first.fromState ?? second.fromState,
        toState: first.toState ?? second.toState,
        triggerOrCondition: chooseLongerText(first.triggerOrCondition, second.triggerOrCondition),
        actor: first.actor ?? second.actor,
        moduleName: first.moduleName ?? second.moduleName,
        sourceWorkItemIds: mergeUnique(first.sourceWorkItemIds, second.sourceWorkItemIds),
        evidence: mergeEvidence(first.evidence, second.evidence),
      }),
    ),
    glossary: mergeItems(
      partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.glossary),
      (item) => [`term:${normalizeKey(item.term)}`],
      (first, second) => ({
        ...preferGlossaryType(first, second),
        definition: chooseLongerText(first.definition, second.definition),
        sourceWorkItemIds: mergeUnique(first.sourceWorkItemIds, second.sourceWorkItemIds),
        evidence: mergeEvidence(first.evidence, second.evidence),
      }),
    ),
    crossDependencies: mergeItems(
      partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.crossDependencies),
      (item) => [
        `id:${normalizeKey(item.id)}`,
        `dependency:${normalizeKey([item.sourceModule, item.targetModule, item.dependencyType].join(" "))}`,
      ],
      (first, second) => ({
        ...first,
        sourceModule: first.sourceModule || second.sourceModule,
        targetModule: first.targetModule || second.targetModule,
        dependencyType: first.dependencyType || second.dependencyType,
        description: chooseLongerText(first.description, second.description),
        sourceWorkItemIds: mergeUnique(first.sourceWorkItemIds, second.sourceWorkItemIds),
        evidence: mergeEvidence(first.evidence, second.evidence),
      }),
    ),
  };

  return ProjectKnowledgeBaseSchema.parse(merged);
}

function mergeItems<TItem>(
  items: TItem[],
  getCandidateKeys: (item: TItem) => string[],
  merge: (first: TItem, second: TItem) => TItem,
) {
  const byPrimaryKey = new Map<string, TItem>();
  const aliases = new Map<string, string>();

  items.forEach((item, index) => {
    const candidateKeys = getCandidateKeys(item).filter((key) => key && !key.endsWith(":"));
    const existingPrimaryKey = candidateKeys
      .map((key) => aliases.get(key) ?? (byPrimaryKey.has(key) ? key : undefined))
      .find(Boolean);

    if (existingPrimaryKey) {
      const existing = byPrimaryKey.get(existingPrimaryKey);
      if (existing) byPrimaryKey.set(existingPrimaryKey, merge(existing, item));
      candidateKeys.forEach((key) => aliases.set(key, existingPrimaryKey));
      return;
    }

    const primaryKey = candidateKeys[0] ?? `item:${index}`;
    byPrimaryKey.set(primaryKey, item);
    candidateKeys.forEach((key) => aliases.set(key, primaryKey));
  });

  return Array.from(byPrimaryKey.values());
}

function normalizeKey(value: string | undefined) {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u0600-\u06ff-]+/gu, "")
    .replace(/-+/g, "-") ?? "";
}

function chooseLongerText(first: string, second: string) {
  return second.trim().length > first.trim().length ? second : first;
}

function mergeEvidence(first: string, second: string) {
  return mergeUnique(splitEvidence(first), splitEvidence(second)).join(" | ");
}

function preferGlossaryType(
  first: ProjectKnowledgeBase["glossary"][number],
  second: ProjectKnowledgeBase["glossary"][number],
) {
  const firstPriority = GLOSSARY_TYPE_PRIORITY[first.type];
  const secondPriority = GLOSSARY_TYPE_PRIORITY[second.type];
  return secondPriority < firstPriority ? second : first;
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
    user: buildProjectKnowledgeConsolidationUserPrompt({
      scope: input.scope,
      partialKnowledgeBases: partialResults.map((result) => result.validatedOutput),
    }),
    maxTokens: 20000,
    metadata: {
      action: "project_knowledge.consolidate",
      promptName: projectKnowledgeConsolidationPrompt.name,
      promptVersion: projectKnowledgeConsolidationPrompt.version,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
      azureOrganizationUrl: input.scope.azureOrganizationUrl,
    },
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
    user: buildProjectKnowledgeExtractionUserPrompt({
      scope: input.scope,
      workItems: input.workItems,
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
    }),
    maxTokens: 20000,
    metadata: {
      action: "project_knowledge.extract",
      promptName: projectKnowledgeExtractionPrompt.name,
      promptVersion: projectKnowledgeExtractionPrompt.version,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
      azureOrganizationUrl: input.scope.azureOrganizationUrl,
    },
  });
}

function buildProjectKnowledgeExtractionUserPrompt(input: {
  scope: ProjectScope;
  workItems: ProjectKnowledgeWorkItem[];
  batchIndex?: number;
  batchCount?: number;
}) {
  return JSON.stringify({
    requiredOutputShape: PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
    extractionMode: input.batchCount ? "batch" : "full",
    batchIndex: input.batchIndex,
    batchCount: input.batchCount,
    workItems: input.workItems,
    projectScope: {
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
    },
  }, null, 2);
}

function buildProjectKnowledgeConsolidationUserPrompt(input: {
  scope: ProjectScope;
  partialKnowledgeBases: ProjectKnowledgeBase[];
}) {
  return JSON.stringify({
    requiredOutputShape: PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
    partialKnowledgeBases: input.partialKnowledgeBases,
    projectScope: {
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
    },
  }, null, 2);
}

function loadProjectKnowledgeWorkItems(scope: ProjectScope): ProjectKnowledgeWorkItem[] {
  ensureProjectContextSyncSchema();
  const db = getDatabase();
  const rows = db
    .prepare(
      `
      SELECT azure_work_item_id, work_item_type, title, description,
             acceptance_criteria, state, tags, area_path, iteration_path, updated_date
      FROM azure_devops_work_items
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND COALESCE(sync_status, 'active') = 'active'
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
  mode: ProjectKnowledgeCompilationMode;
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
    refreshProjectKnowledgeSearchIndex({
      scope: input.scope,
      knowledgeBaseId: id,
      knowledgeBase: input.knowledgeBase,
    });
    recordProjectKnowledgeRevision({
      scope: input.scope,
      knowledgeBaseId: id,
      knowledgeBase: input.knowledgeBase,
      provider: input.provider,
      model: input.model,
      rawOutput: input.rawOutput,
      sourceWorkItemCount: input.sourceWorkItemCount,
      mode: input.mode,
      sourceChangeSummary: getKnowledgeCounts(input.knowledgeBase),
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  try {
    runProjectKnowledgeLint({ scope: input.scope });
  } catch (error) {
    console.error("Project knowledge lint failed after snapshot save", error);
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

function splitEvidence(evidence: string) {
  return evidence
    .split(/\s+\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mergeUnique(first: string[], second: string[]) {
  return Array.from(new Set([...first, ...second].map((value) => value.trim()).filter(Boolean)));
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
