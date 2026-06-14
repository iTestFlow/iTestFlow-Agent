import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";
import type { BulkTaskResult, BulkTaskTarget, BulkTaskTemplate, CreatedBulkTask, FailedBulkTask, Requirement } from "./azure-devops-types";

const DUPLICATE_TASK_ERROR = "Skipped: matching child task already exists";
const STORY_CONCURRENCY = 4;

export async function createBulkTasks(
  adapter: AzureDevOpsAdapter,
  scopeInput: ProjectScope,
  input: {
    taskTemplates: BulkTaskTemplate[];
    targets: BulkTaskTarget[];
  },
) {
  const scope = assertProjectScope(scopeInput);
  const taskTemplates = input.taskTemplates.map(normalizeTemplate);
  const targets = input.targets.map((target) => ({
    ...target,
    storyId: target.storyId.trim(),
    taskOverrides: target.taskOverrides?.map((override) => ({
      ...override,
      templateId: override.templateId.trim(),
      assignedTo: normalizeOptionalText(override.assignedTo),
    })),
  }));
  const storyResults = await mapWithConcurrency(targets, STORY_CONCURRENCY, (target) =>
    createTasksForStory(adapter, scope.azureProjectId, taskTemplates, target),
  );
  const results = storyResults.flat();
  const created = results.flatMap<CreatedBulkTask>((result) =>
    result.status === "created" && result.taskId
      ? [{
          templateId: result.templateId,
          storyId: result.storyId,
          taskId: result.taskId,
          title: result.title,
        }]
      : [],
  );
  const skipped = results.flatMap<FailedBulkTask>((result) =>
    result.status === "skipped"
      ? [{
          templateId: result.templateId,
          storyId: result.storyId,
          title: result.title,
          error: result.error ?? DUPLICATE_TASK_ERROR,
        }]
      : [],
  );
  const failed = results.flatMap<FailedBulkTask>((result) =>
    result.status === "failed"
      ? [{
          templateId: result.templateId,
          storyId: result.storyId,
          title: result.title,
          error: result.error ?? "Azure DevOps task creation failed.",
        }]
      : [],
  );
  const requestedCount = taskTemplates.length * targets.length;

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    entityType: "work_item",
    entityId: "bulk-tasks",
    action: "azure_devops.bulk_create_tasks",
    status: failed.length === 0 ? "Success" : created.length > 0 ? "Partial failure" : "Failed",
    message: `Created ${created.length} of ${requestedCount} requested Azure DevOps tasks.`,
    details: {
      requestedCount,
      taskTemplateCount: taskTemplates.length,
      targetStoryCount: targets.length,
      created,
      skipped,
      failed,
      results,
    },
  });

  return {
    requestedCount,
    taskTemplateCount: taskTemplates.length,
    targetStoryCount: targets.length,
    created,
    skipped,
    failed,
    results,
  };
}

async function createTasksForStory(
  adapter: AzureDevOpsAdapter,
  projectId: string,
  templates: BulkTaskTemplate[],
  target: BulkTaskTarget,
): Promise<BulkTaskResult[]> {
  const storyId = target.storyId;
  let story: Requirement;

  try {
    story = await adapter.fetchWorkItemById({ projectId, workItemId: storyId });
  } catch (error) {
    const message = sanitizeAzureError(error instanceof Error ? error.message : "Azure DevOps user story fetch failed.");
    return templates.map((template) => failedResult(template, storyId, message));
  }

  if (story.workItemType !== "User Story") {
    const error = `Expected User Story but found ${story.workItemType}.`;
    return templates.map((template) => failedResult(template, storyId, error));
  }

  let existingTaskTitles: Set<string>;
  try {
    existingTaskTitles = await fetchExistingTaskTitles(adapter, projectId, story);
  } catch (error) {
    const message = sanitizeAzureError(error instanceof Error ? error.message : "Azure DevOps child task fetch failed.");
    return templates.map((template) => failedResult(template, storyId, message));
  }

  const results: BulkTaskResult[] = [];
  for (const template of templates) {
    const normalizedTitle = normalizeTitleForMatch(template.title);
    if (existingTaskTitles.has(normalizedTitle)) {
      results.push({
        templateId: template.templateId,
        storyId,
        title: template.title,
        status: "skipped",
        error: DUPLICATE_TASK_ERROR,
      });
      continue;
    }

    const taskOverride = target.taskOverrides?.find((override) => override.templateId === template.templateId);
    const assignedTo = taskOverride?.assignedTo ?? template.assignedTo;
    const originalEstimate = taskOverride?.originalEstimate ?? template.originalEstimate;
    let createResult: Awaited<ReturnType<AzureDevOpsAdapter["createChildTask"]>>;
    try {
      createResult = await adapter.createChildTask({
        projectId,
        parentStoryId: storyId,
        title: template.title,
        description: template.description,
        assignedTo,
        originalEstimate,
        copyEstimateToRemainingWork: template.copyEstimateToRemainingWork,
        areaPath: story.areaPath,
        iterationPath: story.iterationPath,
      });
    } catch (error) {
      results.push(failedResult(
        template,
        storyId,
        sanitizeAzureError(error instanceof Error ? error.message : "Azure DevOps task creation failed."),
      ));
      continue;
    }

    if (!createResult.success || !createResult.azureTaskId) {
      results.push(failedResult(
        template,
        storyId,
        sanitizeAzureError(createResult.error ?? "Azure DevOps task creation failed."),
      ));
      continue;
    }

    existingTaskTitles.add(normalizedTitle);
    results.push({
      templateId: template.templateId,
      storyId,
      title: template.title,
      status: "created",
      taskId: createResult.azureTaskId,
    });
  }

  return results;
}

async function fetchExistingTaskTitles(adapter: AzureDevOpsAdapter, projectId: string, story: Requirement) {
  if (!story.childLinks?.length) return new Set<string>();

  const children = await adapter.fetchWorkItemsByIds({
    projectId,
    workItemIds: story.childLinks,
  });
  return new Set(
    children
      .filter((child) => child.workItemType === "Task")
      .map((child) => normalizeTitleForMatch(child.title)),
  );
}

function failedResult(template: BulkTaskTemplate, storyId: string, error: string): BulkTaskResult {
  return {
    templateId: template.templateId,
    storyId,
    title: template.title,
    status: "failed",
    error,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()),
  );
  return results;
}

function normalizeTemplate(template: BulkTaskTemplate): BulkTaskTemplate {
  return {
    templateId: template.templateId.trim(),
    title: template.title.trim(),
    description: normalizeOptionalText(template.description),
    assignedTo: normalizeOptionalText(template.assignedTo),
    originalEstimate: template.originalEstimate,
    copyEstimateToRemainingWork: template.copyEstimateToRemainingWork ?? true,
  };
}

function normalizeOptionalText(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTitleForMatch(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
