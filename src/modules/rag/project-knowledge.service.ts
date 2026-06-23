import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { truncationAuditDetails } from "@/modules/llm/llm-warnings";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider, LLMResult } from "@/modules/llm/llm-types";
import { addTokenUsage, hasTokenUsage } from "@/modules/llm/token-usage";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import {
  projectKnowledgeConsolidationPrompt,
  projectKnowledgeExtractionPrompt,
} from "@/modules/llm/prompts";
import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import {
  PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import { refreshProjectKnowledgeSearchIndex } from "./context-chatbot-retrieval.service";
import {
  recordProjectKnowledgeLog,
  recordProjectKnowledgeRevision,
  runProjectKnowledgeLint,
  type ProjectKnowledgeCompilationMode,
} from "./project-knowledge-compiled.service";
import { ensureProjectContextSyncSchema } from "./project-context-schema.service";

// Keep each extraction batch's INPUT small enough that its structured OUTPUT comfortably
// fits under the output-token cap. Smaller batches are cheap now that consolidation is a
// local deterministic merge (no per-build LLM call), so we favour staying well under the cap.
const MAX_CONTEXT_INPUT_CHARS = 18000;
// How many extraction batches to run at once. Bounded so large projects don't burst the
// provider's rate limit; deterministic consolidation merges the results regardless of order.
const KNOWLEDGE_BATCH_CONCURRENCY = 3;
type ProjectKnowledgeCompileMode = Extract<ProjectKnowledgeCompilationMode, "incremental" | "full">;
type ProjectKnowledgeSourceHashMap = Record<string, string | null>;

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
  content_hash: string | null;
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
  contentHash?: string | null;
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

export type ProjectKnowledgeGeneratedDraft = {
  promptVersion: string;
  provider: string;
  model: string;
  requestedMode: ProjectKnowledgeCompileMode;
  mode: ProjectKnowledgeCompileMode;
  fallbackReason?: string;
  sourceWorkItemCount: number;
  promptedSourceWorkItemCount: number;
  changedSourceWorkItemCount: number;
  changedSourceWorkItemIds: string[];
  retiredSourceWorkItemCount: number;
  rawOutput: string;
  knowledgeBase: ProjectKnowledgeBase;
  generatedAt: string;
  alreadyCurrent?: boolean;
  warnings?: string[];
};

export async function extractAndSaveProjectKnowledgeBase(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  mode?: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = await loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }
  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope,
    workItems,
    mode: input.mode ?? "incremental",
  });

  if (selection.mode === "incremental" && !selection.workItems.length) {
    const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope });
    if (!existingSnapshot) throw new Error("Run a full knowledge recompile before incremental compilation.");

    if (!selection.retiredSourceWorkItemIds.length) {
      recordProjectKnowledgeLog({
        scope,
        eventType: "knowledge.compile_skipped",
        severity: "info",
        title: "Knowledge compile skipped",
        message: "No source work item changes were found since the latest knowledge revision.",
        metadata: {
          requestedMode: selection.requestedMode,
          mode: selection.mode,
          totalSourceWorkItemCount: workItems.length,
        },
      });
      return existingSnapshot;
    }

    const knowledgeBase = mergeIncrementalProjectKnowledgeBase({
      existingKnowledgeBase: existingSnapshot.knowledgeBase,
      partialKnowledgeBases: [],
      affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
      activeSourceWorkItemIds: workItems.map((item) => item.id),
    });
    const snapshot = await saveProjectKnowledgeBaseSnapshot({
      scope,
      provider: "local",
      model: "local-deterministic",
      rawOutput: JSON.stringify({
        mode: "incremental",
        noModelCall: true,
        retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
      }),
      knowledgeBase,
      sourceWorkItemCount: workItems.length,
      sourceWorkItems: workItems,
      mode: "incremental",
      sourceChangeSummary: buildCompilationSourceChangeSummary({
        knowledgeBase,
        sourceWorkItems: workItems,
        selection,
      }),
    });

    writeAuditLog({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      actor: input.actor,
      action: "rag.extract_project_knowledge_base",
      status: "Success",
      message: "Updated project knowledge base locally for retired source work items.",
      details: {
        requestedMode: selection.requestedMode,
        mode: selection.mode,
        sourceWorkItemCount: workItems.length,
        retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
        counts: getKnowledgeCounts(knowledgeBase),
      },
    });

    return snapshot;
  }

  const result = await extractProjectKnowledgeBase({
    scope,
    provider: input.provider,
    workItems: selection.workItems,
    mode: selection.mode,
  });
  const knowledgeBase = selection.mode === "incremental"
    ? mergeIncrementalProjectKnowledgeBase({
        existingKnowledgeBase: await getRequiredExistingProjectKnowledgeBase(scope),
        partialKnowledgeBases: [result.validatedOutput],
        affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
        activeSourceWorkItemIds: workItems.map((item) => item.id),
      })
    : result.validatedOutput;
  const snapshot = await saveProjectKnowledgeBaseSnapshot({
    scope,
    provider: result.provider,
    model: result.model,
    rawOutput: selection.mode === "incremental"
      ? JSON.stringify({
          mode: "incremental",
          changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
          retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
          extraction: result.rawOutput,
        })
      : result.rawOutput,
    knowledgeBase,
    sourceWorkItemCount: workItems.length,
    sourceWorkItems: workItems,
    mode: selection.mode,
    sourceChangeSummary: buildCompilationSourceChangeSummary({
      knowledgeBase,
      sourceWorkItems: workItems,
      selection,
    }),
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.extract_project_knowledge_base",
    status: "Success",
    message: "Extracted and saved project knowledge base from indexed context.",
    details: {
      ...truncationAuditDetails(result.warnings),
      provider: result.provider,
      model: result.model,
      promptVersion: projectKnowledgeExtractionPrompt.version,
      requestedMode: selection.requestedMode,
      mode: selection.mode,
      fallbackReason: selection.fallbackReason,
      sourceWorkItemCount: workItems.length,
      promptedSourceWorkItemCount: selection.workItems.length,
      changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
      counts: getKnowledgeCounts(knowledgeBase),
    },
  });

  return snapshot;
}

export async function previewGeneratedProjectKnowledgeBase(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  mode?: ProjectKnowledgeCompileMode;
}): Promise<ProjectKnowledgeGeneratedDraft> {
  const scope = assertProjectScope(input.scope);
  const workItems = await loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }

  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope,
    workItems,
    mode: input.mode ?? "incremental",
  });

  if (selection.mode === "incremental" && !selection.workItems.length) {
    const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope });
    if (!existingSnapshot) throw new Error("Run a full knowledge recompile before incremental compilation.");

    const knowledgeBase = selection.retiredSourceWorkItemIds.length
      ? mergeIncrementalProjectKnowledgeBase({
          existingKnowledgeBase: existingSnapshot.knowledgeBase,
          partialKnowledgeBases: [],
          affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
          activeSourceWorkItemIds: workItems.map((item) => item.id),
        })
      : existingSnapshot.knowledgeBase;

    return {
      promptVersion: projectKnowledgeExtractionPrompt.version,
      provider: "local",
      model: "local-deterministic",
      requestedMode: selection.requestedMode,
      mode: selection.mode,
      fallbackReason: selection.fallbackReason,
      sourceWorkItemCount: workItems.length,
      promptedSourceWorkItemCount: selection.workItems.length,
      changedSourceWorkItemCount: selection.changedSourceWorkItemIds.length,
      changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
      retiredSourceWorkItemCount: selection.retiredSourceWorkItemIds.length,
      rawOutput: JSON.stringify({
        mode: "incremental",
        noModelCall: true,
        retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
      }),
      knowledgeBase,
      generatedAt: nowIso(),
      alreadyCurrent: !selection.retiredSourceWorkItemIds.length,
    };
  }

  const result = await extractProjectKnowledgeBase({
    scope,
    provider: input.provider,
    workItems: selection.workItems,
    mode: selection.mode,
  });
  const knowledgeBase = selection.mode === "incremental"
    ? mergeIncrementalProjectKnowledgeBase({
        existingKnowledgeBase: await getRequiredExistingProjectKnowledgeBase(scope),
        partialKnowledgeBases: [result.validatedOutput],
        affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
        activeSourceWorkItemIds: workItems.map((item) => item.id),
      })
    : result.validatedOutput;

  return {
    promptVersion: projectKnowledgeExtractionPrompt.version,
    provider: result.provider,
    model: result.model,
    requestedMode: selection.requestedMode,
    mode: selection.mode,
    fallbackReason: selection.fallbackReason,
    sourceWorkItemCount: workItems.length,
    promptedSourceWorkItemCount: selection.workItems.length,
    changedSourceWorkItemCount: selection.changedSourceWorkItemIds.length,
    changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
    retiredSourceWorkItemCount: selection.retiredSourceWorkItemIds.length,
    rawOutput: selection.mode === "incremental"
      ? JSON.stringify({
          mode: "incremental",
          changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
          retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
          extraction: result.rawOutput,
        })
      : result.rawOutput,
    knowledgeBase,
    generatedAt: nowIso(),
    warnings: result.warnings,
  };
}

export async function saveGeneratedProjectKnowledgeBaseDraft(input: {
  scope: ProjectScope;
  actor: string;
  provider: string;
  model: string;
  rawOutput: string;
  knowledgeBase: ProjectKnowledgeBase;
  requestedMode?: ProjectKnowledgeCompileMode;
  mode: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = await loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }

  const knowledgeBase = ProjectKnowledgeBaseSchema.parse(input.knowledgeBase);
  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope,
    workItems,
    mode: input.requestedMode ?? input.mode,
  });
  const snapshot = await saveProjectKnowledgeBaseSnapshot({
    scope,
    provider: input.provider,
    model: input.model,
    rawOutput: input.rawOutput,
    knowledgeBase,
    sourceWorkItemCount: workItems.length,
    sourceWorkItems: workItems,
    mode: input.mode,
    sourceChangeSummary: buildCompilationSourceChangeSummary({
      knowledgeBase,
      sourceWorkItems: workItems,
      selection: {
        ...selection,
        mode: input.mode,
      },
    }),
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.extract_project_knowledge_base.generated_save",
    status: "Success",
    message: "Saved generated project knowledge base after preview.",
    details: {
      provider: input.provider,
      model: input.model,
      promptVersion: projectKnowledgeExtractionPrompt.version,
      requestedMode: input.requestedMode ?? input.mode,
      mode: input.mode,
      sourceWorkItemCount: workItems.length,
      counts: getKnowledgeCounts(knowledgeBase),
    },
  });

  return snapshot;
}

export async function getProjectKnowledgeBaseSnapshot(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  const row = await sqlGet<ProjectKnowledgeSnapshotRow>(
    `
      SELECT id, prompt_version, provider, model_name, source_work_item_count,
             raw_output, validated_output, status, error_details,
             extracted_at, created_at, updated_at
      FROM project_knowledge_base
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );

  return row ? toProjectKnowledgeSnapshot(row) : null;
}

export async function getSavedProjectKnowledgeBase(input: { scope: ProjectScope }) {
  return (await getProjectKnowledgeBaseSnapshot(input))?.knowledgeBase ?? null;
}

export async function buildProjectKnowledgeManualDraft(input: {
  scope: ProjectScope;
  mode?: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = await loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }
  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope,
    workItems,
    mode: input.mode ?? "full",
  });

  const batches = selection.workItems.length ? buildWorkItemBatches(selection.workItems) : [];

  return {
    schemaName: "ProjectKnowledgeBase",
    promptName: projectKnowledgeExtractionPrompt.name,
    promptVersion: projectKnowledgeExtractionPrompt.version,
    requestedMode: selection.requestedMode,
    mode: selection.mode,
    fallbackReason: selection.fallbackReason,
    sourceWorkItemCount: selection.workItems.length,
    totalSourceWorkItemCount: workItems.length,
    changedSourceWorkItemCount: selection.changedSourceWorkItemIds.length,
    retiredSourceWorkItemCount: selection.retiredSourceWorkItemIds.length,
    batchCount: batches.length,
    batches: batches.map((batch, index) => {
      const batchIndex = index + 1;
      const batchMetadata = batches.length > 1 ? { batchIndex, batchCount: batches.length } : {};
      const userPrompt = buildProjectKnowledgeExtractionUserPrompt({
        scope,
        workItems: batch,
        mode: selection.mode,
        ...batchMetadata,
      });

      return {
        batchIndex,
        batchCount: batches.length,
        workItemCount: batch.length,
        systemPrompt: projectKnowledgeExtractionPrompt.system,
        userPrompt,
        prompt: buildManualPromptMarkdown({
          title: buildManualKnowledgePromptTitle(selection.mode, batchIndex, batches.length),
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

export async function saveManualProjectKnowledgeBaseSnapshot(input: {
  scope: ProjectScope;
  actor: string;
  rawOutput: string;
  mode?: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = await loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }

  const knowledgeBase = validateProjectKnowledgeExternalOutput(input.rawOutput);
  const saveResult = await prepareProjectKnowledgeManualSave({
    scope,
    sourceWorkItems: workItems,
    partialKnowledgeBases: [knowledgeBase],
    rawOutput: input.rawOutput,
    mode: input.mode ?? "full",
  });
  const snapshot = await saveProjectKnowledgeBaseSnapshot({
    scope,
    provider: "external",
    model: "manual-external",
    rawOutput: saveResult.rawOutput,
    knowledgeBase: saveResult.knowledgeBase,
    sourceWorkItemCount: workItems.length,
    sourceWorkItems: workItems,
    mode: saveResult.mode,
    sourceChangeSummary: saveResult.sourceChangeSummary,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.extract_project_knowledge_base.manual_complete",
    status: "Success",
    message: "Extracted and saved project knowledge base from validated external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: projectKnowledgeExtractionPrompt.version,
      requestedMode: input.mode ?? "full",
      mode: saveResult.mode,
      promptedSourceWorkItemCount: saveResult.promptedSourceWorkItemCount,
      changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
      sourceWorkItemCount: workItems.length,
      counts: getKnowledgeCounts(saveResult.knowledgeBase),
    },
  });

  return snapshot;
}

export async function saveManualProjectKnowledgeBaseFromBatches(input: {
  scope: ProjectScope;
  actor: string;
  partialKnowledgeBases: ProjectKnowledgeBase[];
  mode?: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const workItems = await loadProjectKnowledgeWorkItems(scope);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }
  if (!input.partialKnowledgeBases.length && (input.mode ?? "full") !== "incremental") {
    throw new Error("Validate at least one batch response before saving the knowledge base.");
  }

  const saveResult = await prepareProjectKnowledgeManualSave({
    scope,
    sourceWorkItems: workItems,
    partialKnowledgeBases: input.partialKnowledgeBases,
    mode: input.mode ?? "full",
  });
  const rawOutput = JSON.stringify({
    consolidationMode: "local-deterministic",
    mode: saveResult.mode,
    changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
    retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
    partialKnowledgeBases: input.partialKnowledgeBases,
    consolidatedKnowledgeBase: saveResult.knowledgeBase,
  });
  const snapshot = await saveProjectKnowledgeBaseSnapshot({
    scope,
    provider: "external",
    model: "manual-external",
    rawOutput,
    knowledgeBase: saveResult.knowledgeBase,
    sourceWorkItemCount: workItems.length,
    sourceWorkItems: workItems,
    mode: saveResult.mode,
    sourceChangeSummary: saveResult.sourceChangeSummary,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.extract_project_knowledge_base.manual_batch_complete",
    status: "Success",
    message: "Extracted and saved project knowledge base from locally consolidated external LLM batch output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: projectKnowledgeExtractionPrompt.version,
      requestedMode: input.mode ?? "full",
      mode: saveResult.mode,
      sourceWorkItemCount: workItems.length,
      promptedSourceWorkItemCount: saveResult.promptedSourceWorkItemCount,
      changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
      batchCount: input.partialKnowledgeBases.length,
      counts: getKnowledgeCounts(saveResult.knowledgeBase),
    },
  });

  return snapshot;
}

type ProjectKnowledgeWorkItemSelection = {
  requestedMode: ProjectKnowledgeCompileMode;
  mode: ProjectKnowledgeCompileMode;
  fallbackReason?: string;
  workItems: ProjectKnowledgeWorkItem[];
  changedSourceWorkItemIds: string[];
  retiredSourceWorkItemIds: string[];
  affectedSourceWorkItemIds: string[];
};

async function selectProjectKnowledgeWorkItemsForCompilation(input: {
  scope: ProjectScope;
  workItems: ProjectKnowledgeWorkItem[];
  mode: ProjectKnowledgeCompileMode;
}): Promise<ProjectKnowledgeWorkItemSelection> {
  if (input.mode === "full") {
    return {
      requestedMode: input.mode,
      mode: "full",
      workItems: input.workItems,
      changedSourceWorkItemIds: input.workItems.map((item) => item.id),
      retiredSourceWorkItemIds: [],
      affectedSourceWorkItemIds: input.workItems.map((item) => item.id),
    };
  }

  const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope: input.scope });
  if (!existingSnapshot) {
    return {
      requestedMode: input.mode,
      mode: "full",
      fallbackReason: "No saved knowledge base exists yet, so the first compile must include every active work item.",
      workItems: input.workItems,
      changedSourceWorkItemIds: input.workItems.map((item) => item.id),
      retiredSourceWorkItemIds: [],
      affectedSourceWorkItemIds: input.workItems.map((item) => item.id),
    };
  }

  const previousSourceHashes = await loadLatestProjectKnowledgeSourceHashes(input.scope);
  if (!previousSourceHashes) {
    return selectProjectKnowledgeWorkItemsFromSnapshotTimestamp({
      requestedMode: input.mode,
      existingSnapshot,
      workItems: input.workItems,
    });
  }

  const currentSourceHashes = buildSourceWorkItemHashMap(input.workItems);
  const changedSourceWorkItemIds = input.workItems
    .filter((item) => previousSourceHashes[item.id] !== currentSourceHashes[item.id])
    .map((item) => item.id);
  const currentSourceIds = new Set(input.workItems.map((item) => item.id));
  const retiredSourceWorkItemIds = Object.keys(previousSourceHashes).filter((sourceId) => !currentSourceIds.has(sourceId));
  const affectedSourceWorkItemIds = Array.from(new Set([...changedSourceWorkItemIds, ...retiredSourceWorkItemIds]));

  return {
    requestedMode: input.mode,
    mode: "incremental",
    workItems: input.workItems.filter((item) => changedSourceWorkItemIds.includes(item.id)),
    changedSourceWorkItemIds,
    retiredSourceWorkItemIds,
    affectedSourceWorkItemIds,
  };
}

function selectProjectKnowledgeWorkItemsFromSnapshotTimestamp(input: {
  requestedMode: ProjectKnowledgeCompileMode;
  existingSnapshot: ProjectKnowledgeSnapshot;
  workItems: ProjectKnowledgeWorkItem[];
}): ProjectKnowledgeWorkItemSelection {
  const extractedAtMs = Date.parse(input.existingSnapshot.extractedAt);
  const changedSourceWorkItemIds = Number.isFinite(extractedAtMs)
    ? input.workItems
        .filter((item) => {
          const updatedAtMs = Date.parse(item.updatedDate ?? "");
          return Number.isFinite(updatedAtMs) && updatedAtMs > extractedAtMs;
        })
        .map((item) => item.id)
    : [];
  const activeSourceIds = new Set(input.workItems.map((item) => item.id));
  const retiredSourceWorkItemIds = getKnowledgeSourceWorkItemIds(input.existingSnapshot.knowledgeBase)
    .filter((sourceId) => !activeSourceIds.has(sourceId));
  const affectedSourceWorkItemIds = Array.from(new Set([...changedSourceWorkItemIds, ...retiredSourceWorkItemIds]));

  return {
    requestedMode: input.requestedMode,
    mode: "incremental",
    fallbackReason: "The saved knowledge revision does not include source hashes yet, so Compile Prompt used the saved extraction time as its baseline. Save the no-prompt baseline once to enable exact hash-based incremental prompts.",
    workItems: input.workItems.filter((item) => changedSourceWorkItemIds.includes(item.id)),
    changedSourceWorkItemIds,
    retiredSourceWorkItemIds,
    affectedSourceWorkItemIds,
  };
}

async function prepareProjectKnowledgeManualSave(input: {
  scope: ProjectScope;
  sourceWorkItems: ProjectKnowledgeWorkItem[];
  partialKnowledgeBases: ProjectKnowledgeBase[];
  rawOutput?: string;
  mode: ProjectKnowledgeCompileMode;
}) {
  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope: input.scope,
    workItems: input.sourceWorkItems,
    mode: input.mode,
  });
  const mode: ProjectKnowledgeCompileMode = input.mode === "incremental" && selection.mode === "incremental" ? "incremental" : "full";
  if (!input.partialKnowledgeBases.length && mode !== "incremental") {
    throw new Error("Validate at least one batch response before saving the knowledge base.");
  }

  const knowledgeBase = mode === "incremental"
    ? mergeIncrementalProjectKnowledgeBase({
        existingKnowledgeBase: await getRequiredExistingProjectKnowledgeBase(input.scope),
        partialKnowledgeBases: input.partialKnowledgeBases,
        affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
        activeSourceWorkItemIds: input.sourceWorkItems.map((item) => item.id),
      })
    : consolidateProjectKnowledgeBases(input.partialKnowledgeBases);
  const sourceChangeSummary = buildCompilationSourceChangeSummary({
    knowledgeBase,
    sourceWorkItems: input.sourceWorkItems,
    selection: {
      ...selection,
      mode,
    },
  });

  return {
    mode,
    knowledgeBase,
    rawOutput: mode === "incremental"
      ? JSON.stringify({
          mode,
          changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
          retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
          externalOutput: input.rawOutput,
          partialKnowledgeBases: input.partialKnowledgeBases,
          consolidatedKnowledgeBase: knowledgeBase,
        })
      : input.rawOutput ?? JSON.stringify({
          mode,
          partialKnowledgeBases: input.partialKnowledgeBases,
          consolidatedKnowledgeBase: knowledgeBase,
        }),
    sourceChangeSummary,
    promptedSourceWorkItemCount: mode === "incremental" ? selection.workItems.length : input.sourceWorkItems.length,
    changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
    retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
  };
}

function mergeIncrementalProjectKnowledgeBase(input: {
  existingKnowledgeBase: ProjectKnowledgeBase;
  partialKnowledgeBases: ProjectKnowledgeBase[];
  affectedSourceWorkItemIds: string[];
  activeSourceWorkItemIds: string[];
}) {
  const affectedSourceIds = new Set(input.affectedSourceWorkItemIds);
  const activeSourceIds = new Set(input.activeSourceWorkItemIds);
  const retainedKnowledgeBase = pruneKnowledgeBaseBySource(input.existingKnowledgeBase, affectedSourceIds, activeSourceIds);
  return consolidateProjectKnowledgeBases([retainedKnowledgeBase, ...input.partialKnowledgeBases]);
}

function pruneKnowledgeBaseBySource(
  knowledgeBase: ProjectKnowledgeBase,
  affectedSourceIds: Set<string>,
  activeSourceIds: Set<string>,
): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: pruneSourceBackedItems(knowledgeBase.modules, affectedSourceIds, activeSourceIds),
    businessRules: pruneSourceBackedItems(knowledgeBase.businessRules, affectedSourceIds, activeSourceIds),
    stateTransitions: pruneSourceBackedItems(knowledgeBase.stateTransitions, affectedSourceIds, activeSourceIds),
    glossary: pruneSourceBackedItems(knowledgeBase.glossary, affectedSourceIds, activeSourceIds),
    crossDependencies: pruneSourceBackedItems(knowledgeBase.crossDependencies, affectedSourceIds, activeSourceIds),
  });
}

function pruneSourceBackedItems<TItem extends { sourceWorkItemIds: string[] }>(
  items: TItem[],
  affectedSourceIds: Set<string>,
  activeSourceIds: Set<string>,
) {
  return items
    .map((item) => {
      const sourceWorkItemIds = item.sourceWorkItemIds.filter((sourceId) => activeSourceIds.has(sourceId) && !affectedSourceIds.has(sourceId));
      if (sourceWorkItemIds.length === item.sourceWorkItemIds.length) return item;
      if (!sourceWorkItemIds.length) return null;
      return { ...item, sourceWorkItemIds };
    })
    .filter((item): item is TItem => Boolean(item));
}

async function getRequiredExistingProjectKnowledgeBase(scope: ProjectScope) {
  const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope });
  if (!existingSnapshot) throw new Error("Run a full knowledge recompile before incremental compilation.");
  return existingSnapshot.knowledgeBase;
}

function buildCompilationSourceChangeSummary(input: {
  knowledgeBase: ProjectKnowledgeBase;
  sourceWorkItems: ProjectKnowledgeWorkItem[];
  selection?: Partial<ProjectKnowledgeWorkItemSelection>;
}) {
  const knowledgeCounts = getKnowledgeCounts(input.knowledgeBase);
  return {
    ...knowledgeCounts,
    knowledgeCounts,
    sourceWorkItemIds: input.sourceWorkItems.map((item) => item.id),
    sourceWorkItemHashes: buildSourceWorkItemHashMap(input.sourceWorkItems),
    totalSourceWorkItemCount: input.sourceWorkItems.length,
    requestedMode: input.selection?.requestedMode,
    mode: input.selection?.mode,
    fallbackReason: input.selection?.fallbackReason,
    promptedSourceWorkItemCount: input.selection?.workItems?.length ?? input.sourceWorkItems.length,
    changedSourceWorkItemIds: input.selection?.changedSourceWorkItemIds ?? [],
    retiredSourceWorkItemIds: input.selection?.retiredSourceWorkItemIds ?? [],
  };
}

function buildSourceWorkItemHashMap(workItems: ProjectKnowledgeWorkItem[]): ProjectKnowledgeSourceHashMap {
  return Object.fromEntries(workItems.map((item) => [item.id, item.contentHash ?? null]));
}

function getKnowledgeSourceWorkItemIds(knowledgeBase: ProjectKnowledgeBase) {
  return Array.from(new Set([
    ...knowledgeBase.modules.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.businessRules.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.stateTransitions.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.glossary.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.crossDependencies.flatMap((item) => item.sourceWorkItemIds),
  ].map((sourceId) => sourceId.trim()).filter(Boolean)));
}

async function loadLatestProjectKnowledgeSourceHashes(scope: ProjectScope): Promise<ProjectKnowledgeSourceHashMap | null> {
  const row = await sqlGet<{ source_change_summary_json: string | null }>(
    `
      SELECT source_change_summary_json
      FROM project_knowledge_revisions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY revision_number DESC
      LIMIT 1
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );

  if (!row?.source_change_summary_json) return null;
  try {
    const parsed = JSON.parse(row.source_change_summary_json) as { sourceWorkItemHashes?: unknown };
    if (!parsed.sourceWorkItemHashes || Array.isArray(parsed.sourceWorkItemHashes) || typeof parsed.sourceWorkItemHashes !== "object") {
      return null;
    }
    const hashes: ProjectKnowledgeSourceHashMap = {};
    Object.entries(parsed.sourceWorkItemHashes as Record<string, unknown>).forEach(([sourceId, hash]) => {
      if (typeof hash === "string" || hash === null) hashes[sourceId] = hash;
    });
    return Object.keys(hashes).length ? hashes : null;
  } catch {
    return null;
  }
}

function buildManualKnowledgePromptTitle(mode: ProjectKnowledgeCompileMode, batchIndex: number, batchCount: number) {
  const title = mode === "incremental"
    ? "iTestFlow Knowledge Base Compile"
    : "iTestFlow Knowledge Base Full Recompile";
  return batchCount > 1 ? `${title} - Batch ${batchIndex} of ${batchCount}` : title;
}

function toPromptWorkItem(item: ProjectKnowledgeWorkItem) {
  return {
    id: item.id,
    workItemType: item.workItemType,
    title: item.title,
    state: item.state,
    description: item.description,
    acceptanceCriteria: item.acceptanceCriteria,
    tags: item.tags,
    areaPath: item.areaPath,
    iterationPath: item.iterationPath,
    updatedDate: item.updatedDate,
  };
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
  mode: ProjectKnowledgeCompileMode;
}): Promise<LLMResult<ProjectKnowledgeBase>> {
  const batches = buildWorkItemBatches(input.workItems);
  if (batches.length === 1) {
    return extractProjectKnowledgeBatch({
      scope: input.scope,
      provider: input.provider,
      workItems: batches[0],
      mode: input.mode,
    });
  }

  // Extract batches with bounded concurrency, preserving batch order in partialResults.
  const partialResults: Awaited<ReturnType<typeof extractProjectKnowledgeBatch>>[] = [];
  for (let start = 0; start < batches.length; start += KNOWLEDGE_BATCH_CONCURRENCY) {
    const chunk = batches.slice(start, start + KNOWLEDGE_BATCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map((workItems, offset) =>
        extractProjectKnowledgeBatch({
          scope: input.scope,
          provider: input.provider,
          workItems,
          mode: input.mode,
          batchIndex: start + offset + 1,
          batchCount: batches.length,
        }),
      ),
    );
    partialResults.push(...chunkResults);
  }

  // Deterministic, Zod-validated merge — mirrors the manual/external save path
  // (prepareProjectKnowledgeManualSave). This avoids an unbounded LLM "re-emit the whole
  // knowledge base" call, whose output overflows the token cap and hard-fails the build.
  const validatedOutput = consolidateProjectKnowledgeBases(
    partialResults.map((result) => result.validatedOutput),
  );

  // A truncation warning from any batch applies to the whole extraction; dedupe identical messages.
  const aggregatedWarnings = [...new Set(partialResults.flatMap((result) => result.warnings ?? []))];

  return {
    provider: partialResults[0].provider,
    model: partialResults[0].model,
    validatedOutput,
    tokenUsage: partialResults.every((result) => hasTokenUsage(result.tokenUsage))
      ? partialResults.reduce(
          (total, result) => addTokenUsage(total, result.tokenUsage),
          undefined as LLMResult["tokenUsage"],
        )
      : undefined,
    warnings: aggregatedWarnings.length ? aggregatedWarnings : undefined,
    rawOutput: JSON.stringify({
      mode: input.mode,
      consolidation: "local-deterministic",
      batches: partialResults.map((result) => result.rawOutput),
      consolidatedKnowledgeBase: validatedOutput,
    }),
  };
}

async function extractProjectKnowledgeBatch(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  workItems: ProjectKnowledgeWorkItem[];
  mode: ProjectKnowledgeCompileMode;
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
      mode: input.mode,
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
    }),
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
  mode: ProjectKnowledgeCompileMode;
  batchIndex?: number;
  batchCount?: number;
}) {
  return JSON.stringify({
    requiredOutputShape: PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
    extractionMode: input.batchCount ? "batch" : input.mode,
    knowledgeCompileMode: input.mode,
    incrementalInstruction: input.mode === "incremental"
      ? "Extract knowledge only from the provided changed workItems. The application will merge this partial output with the saved project knowledge locally."
      : undefined,
    batchIndex: input.batchIndex,
    batchCount: input.batchCount,
    workItems: input.workItems.map(toPromptWorkItem),
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

function loadProjectKnowledgeWorkItems(scope: ProjectScope): Promise<ProjectKnowledgeWorkItem[]> {
  ensureProjectContextSyncSchema();
  return sqlAll<ProjectKnowledgeWorkItemRow>(
    `
      SELECT azure_work_item_id, work_item_type, title, description,
             acceptance_criteria, state, tags, area_path, iteration_path, updated_date,
             content_hash
      FROM azure_devops_work_items
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND COALESCE(sync_status, 'active') = 'active'
      ORDER BY work_item_type ASC, azure_work_item_id ASC
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  ).then((rows) =>
    rows.map((row) => ({
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
      contentHash: row.content_hash,
    })),
  );
}

async function saveProjectKnowledgeBaseSnapshot(input: {
  scope: ProjectScope;
  provider: string;
  model: string;
  rawOutput: string;
  knowledgeBase: ProjectKnowledgeBase;
  sourceWorkItemCount: number;
  sourceWorkItems: ProjectKnowledgeWorkItem[];
  mode: ProjectKnowledgeCompilationMode;
  sourceChangeSummary?: Record<string, unknown>;
}) {
  const now = nowIso();
  const id = createId("pkb");
  const validatedOutput = JSON.stringify(input.knowledgeBase);

  await withTransaction(async (client) => {
    await sqlRun(
      `
        DELETE FROM project_knowledge_base
        WHERE project_id = @projectId
          AND azure_project_id = @azureProjectId
      `,
      {
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
      },
      client,
    );
    await sqlRun(
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
      {
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
      },
      client,
    );
    await refreshProjectKnowledgeSearchIndex(
      {
        scope: input.scope,
        knowledgeBaseId: id,
        knowledgeBase: input.knowledgeBase,
      },
      client,
    );
    await recordProjectKnowledgeRevision(
      {
        scope: input.scope,
        knowledgeBaseId: id,
        knowledgeBase: input.knowledgeBase,
        provider: input.provider,
        model: input.model,
        rawOutput: input.rawOutput,
        sourceWorkItemCount: input.sourceWorkItemCount,
        mode: input.mode,
        sourceChangeSummary: input.sourceChangeSummary ?? buildCompilationSourceChangeSummary({
          knowledgeBase: input.knowledgeBase,
          sourceWorkItems: input.sourceWorkItems,
        }),
      },
      client,
    );
  });

  // Lint runs after the snapshot transaction commits; a lint failure must not
  // roll back the saved snapshot.
  try {
    await runProjectKnowledgeLint({ scope: input.scope });
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
