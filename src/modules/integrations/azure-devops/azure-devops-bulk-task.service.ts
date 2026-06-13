import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";
import type { BulkTaskResult, BulkTaskTarget, BulkTaskTemplate, CreatedBulkTask, FailedBulkTask, Requirement } from "./azure-devops-types";

const DUPLICATE_TASK_ERROR = "Skipped: matching child task already exists";

export async function createBulkTasks(
  adapter: AzureDevOpsAdapter,
  scopeInput: ProjectScope,
  input: {
    template: BulkTaskTemplate;
    tasks: BulkTaskTarget[];
  },
) {
  const scope = assertProjectScope(scopeInput);
  const template = normalizeTemplate(input.template);
  const created: CreatedBulkTask[] = [];
  const failed: FailedBulkTask[] = [];
  const results: BulkTaskResult[] = [];

  for (const task of input.tasks) {
    const storyId = task.storyId.trim();

    try {
      const story = await adapter.fetchWorkItemById({ projectId: scope.azureProjectId, workItemId: storyId });
      if (story.workItemType !== "User Story") {
        const error = `Expected User Story but found ${story.workItemType}.`;
        failed.push({ storyId, error, status: "failed" });
        results.push({ storyId, status: "failed", error });
        continue;
      }

      const duplicate = await findMatchingChildTask(adapter, scope.azureProjectId, story, template.title);
      if (duplicate) {
        failed.push({ storyId, error: DUPLICATE_TASK_ERROR, status: "skipped" });
        results.push({ storyId, status: "skipped", error: DUPLICATE_TASK_ERROR });
        continue;
      }

      const assignedTo = normalizeOptionalText(task.assignedTo) ?? template.assignedTo;
      const originalEstimate = task.originalEstimate ?? template.originalEstimate;
      const createResult = await adapter.createChildTask({
        projectId: scope.azureProjectId,
        parentStoryId: storyId,
        title: template.title,
        description: template.description,
        assignedTo,
        originalEstimate,
        copyEstimateToRemainingWork: template.copyEstimateToRemainingWork,
        areaPath: story.areaPath,
        iterationPath: story.iterationPath,
      });

      if (!createResult.success || !createResult.azureTaskId) {
        const error = sanitizeAzureError(createResult.error ?? "Azure DevOps task creation failed.");
        failed.push({ storyId, error, status: "failed" });
        results.push({ storyId, status: "failed", error });
        continue;
      }

      created.push({ storyId, taskId: createResult.azureTaskId, title: template.title });
      results.push({ storyId, status: "created", taskId: createResult.azureTaskId });
    } catch (error) {
      const message = sanitizeAzureError(error instanceof Error ? error.message : "Azure DevOps task creation failed.");
      failed.push({ storyId, error: message, status: "failed" });
      results.push({ storyId, status: "failed", error: message });
    }
  }

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    entityType: "work_item",
    entityId: "bulk-tasks",
    action: "azure_devops.bulk_create_tasks",
    status: failed.length === 0 ? "Success" : created.length > 0 ? "Partial failure" : "Failed",
    message: `Created ${created.length} of ${input.tasks.length} requested Azure DevOps tasks.`,
    details: {
      requestedCount: input.tasks.length,
      created,
      failed,
      results,
    },
  });

  return {
    requestedCount: input.tasks.length,
    created,
    failed,
    results,
  };
}

async function findMatchingChildTask(adapter: AzureDevOpsAdapter, projectId: string, story: Requirement, title: string) {
  if (!story.childLinks?.length) return undefined;

  const children = await adapter.fetchWorkItemsByIds({
    projectId,
    workItemIds: story.childLinks,
  });
  const normalizedTitle = normalizeTitleForMatch(title);

  return children.find((child) => child.workItemType === "Task" && normalizeTitleForMatch(child.title) === normalizedTitle);
}

function normalizeTemplate(template: BulkTaskTemplate): BulkTaskTemplate {
  return {
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
