import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { DEFAULT_AUTO_UPDATE_CRON_EXPRESSION, isCronExpressionDue, minuteKeyForDate } from "@/modules/settings/cron-expression";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { extractAndSaveProjectKnowledgeBase, type ProjectKnowledgeSnapshot } from "./project-knowledge.service";
import { indexAzureWorkItemsAsProjectContext } from "./project-context-store.service";
import {
  completeContextAutoUpdateRun,
  startContextAutoUpdateRun,
  type ContextAutoUpdateRunStatus,
} from "./context-auto-update-run-history.service";

const CHECK_INTERVAL_MS = 60_000;

type SchedulerState = {
  started: boolean;
  running: boolean;
  lastMatchedKey?: string;
  timer?: ReturnType<typeof setInterval>;
};

type ContextIndexResult = Awaited<ReturnType<typeof indexAzureWorkItemsAsProjectContext>>;

const globalScheduler = globalThis as typeof globalThis & {
  __itestflowContextAutoUpdateScheduler?: SchedulerState;
};

export function startContextAutoUpdateScheduler() {
  const state = getSchedulerState();
  if (state.started) return;

  state.started = true;
  void tickContextAutoUpdateScheduler();
  state.timer = setInterval(() => {
    void tickContextAutoUpdateScheduler();
  }, CHECK_INTERVAL_MS);
  state.timer.unref?.();
}

export async function tickContextAutoUpdateScheduler(now = new Date()) {
  const state = getSchedulerState();
  const settings = getEffectiveRuntimeSettings();
  const autoUpdate = settings?.context.autoUpdate;

  if (!autoUpdate?.enabled || !autoUpdate.projectScope) return;

  const cronExpression = autoUpdate.cronExpression || DEFAULT_AUTO_UPDATE_CRON_EXPRESSION;
  if (!isCronExpressionDue(cronExpression, now)) return;

  const dueKey = [
    cronExpression,
    autoUpdate.projectScope.projectId,
    autoUpdate.projectScope.azureProjectId,
    autoUpdate.workItemTypes.join(","),
    autoUpdate.states.join(","),
    minuteKeyForDate(now),
  ].join(":");
  if (state.lastMatchedKey === dueKey) return;
  state.lastMatchedKey = dueKey;

  if (state.running) {
    writeAuditLog({
      projectId: autoUpdate.projectScope.projectId,
      azureProjectId: autoUpdate.projectScope.azureProjectId,
      azureProjectName: autoUpdate.projectScope.azureProjectName,
      azureOrganizationUrl: autoUpdate.projectScope.azureOrganizationUrl,
      action: "rag.auto_update_context.skipped_overlap",
      status: "Info",
      actor: "system",
      message: "Skipped scheduled context update because a previous scheduled update is still running.",
      details: {
        cronExpression,
        workItemTypes: autoUpdate.workItemTypes,
        states: autoUpdate.states,
      },
    });
    return;
  }

  state.running = true;
  try {
    await runScheduledContextAutoUpdate({
      scope: autoUpdate.projectScope,
      cronExpression,
      workItemTypes: autoUpdate.workItemTypes,
      states: autoUpdate.states,
    });
  } finally {
    state.running = false;
  }
}

export async function runScheduledContextAutoUpdate(input: {
  scope: ProjectScope;
  cronExpression: string;
  workItemTypes: string[];
  states: string[];
}) {
  const scope = assertProjectScope(input.scope);
  const runId = startContextAutoUpdateRun({
    scope,
    cronExpression: input.cronExpression,
    workItemTypes: input.workItemTypes,
    states: input.states,
  });
  let contextResult: ContextIndexResult | null = null;
  let knowledgeSnapshot: ProjectKnowledgeSnapshot | null = null;

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "rag.auto_update_context.started",
    status: "Pending",
    actor: "system",
    message: "Started scheduled project context and knowledge base update.",
    details: {
      cronExpression: input.cronExpression,
      workItemTypes: input.workItemTypes,
      states: input.states,
    },
  });

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    contextResult = await indexAzureWorkItemsAsProjectContext({
      scope,
      adapter,
      workItemTypes: input.workItemTypes,
      states: input.states,
    });

    const provider = getConfiguredProviderFromEnv();
    if (!provider) throw new Error("No LLM provider configured for scheduled knowledge base extraction.");

    knowledgeSnapshot = await extractAndSaveProjectKnowledgeBase({
      scope,
      provider,
    });

    completeRun({
      runId,
      status: "Success",
      contextResult,
      knowledgeSnapshot,
    });

    writeAuditLog({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      action: "rag.auto_update_context.completed",
      status: "Success",
      actor: "system",
      message: "Completed scheduled project context and knowledge base update.",
      details: {
        cronExpression: input.cronExpression,
        workItemTypes: input.workItemTypes,
        states: input.states,
        context: contextResult,
        knowledgeBaseId: knowledgeSnapshot.id,
        knowledgeSourceWorkItemCount: knowledgeSnapshot.sourceWorkItemCount,
      },
    });
  } catch (error) {
    const status: Exclude<ContextAutoUpdateRunStatus, "Running"> = contextResult ? "Partial failure" : "Failed";
    const message = error instanceof Error ? error.message : "Scheduled project context update failed.";

    completeRun({
      runId,
      status,
      contextResult,
      knowledgeSnapshot,
      errorDetails: message,
    });

    writeAuditLog({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      action: "rag.auto_update_context.failed",
      status,
      actor: "system",
      message,
      details: {
        cronExpression: input.cronExpression,
        workItemTypes: input.workItemTypes,
        states: input.states,
        context: contextResult,
      },
    });
  }
}

function completeRun(input: {
  runId: string;
  status: Exclude<ContextAutoUpdateRunStatus, "Running">;
  contextResult: ContextIndexResult | null;
  knowledgeSnapshot: ProjectKnowledgeSnapshot | null;
  errorDetails?: string;
}) {
  completeContextAutoUpdateRun({
    id: input.runId,
    status: input.status,
    contextFetchedCount: input.contextResult?.fetchedCount ?? 0,
    contextIndexedWorkItemCount: input.contextResult?.indexedWorkItemCount ?? 0,
    contextIndexedChunkCount: input.contextResult?.indexedChunkCount ?? 0,
    knowledgeBaseId: input.knowledgeSnapshot?.id ?? null,
    knowledgeSourceWorkItemCount: input.knowledgeSnapshot?.sourceWorkItemCount ?? 0,
    errorDetails: input.errorDetails ?? null,
  });
}

function getSchedulerState() {
  if (!globalScheduler.__itestflowContextAutoUpdateScheduler) {
    globalScheduler.__itestflowContextAutoUpdateScheduler = {
      started: false,
      running: false,
    };
  }
  return globalScheduler.__itestflowContextAutoUpdateScheduler;
}
