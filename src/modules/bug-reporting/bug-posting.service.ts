import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type {
  AzureAttachmentUpload,
  AzureBugCustomField,
  AzureIteration,
  AzureWorkItemFieldValue,
  AzureWorkItemTypeField,
  Requirement,
} from "@/modules/integrations/azure-devops/azure-devops-types";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { type BugCustomFieldValue, FinalBugReportSchema } from "./schemas/bug-report.schema";

export type BugAttachmentInput = AzureAttachmentUpload;

export type BugAttachmentResult = {
  fileName: string;
  success: boolean;
  attachmentUrl?: string;
  error?: string;
};

export type PostBugResult = {
  bugId: string;
  webUrl: string;
  attachmentResults: BugAttachmentResult[];
};

export async function postBugReportToAzureDevOps(input: {
  adapter: AzureDevOpsAdapter;
  scope: ProjectScope;
  actor: string;
  report: unknown;
  parentStoryId?: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
  attachments?: BugAttachmentInput[];
}) {
  const scope = assertProjectScope(input.scope);
  const report = FinalBugReportSchema.parse(input.report);
  const fieldMetadata = await input.adapter.fetchWorkItemTypeFields({ projectId: scope.azureProjectId, workItemType: "Bug" });
  const parentStory = await fetchParentStory(input.adapter, scope.azureProjectId, input.parentStoryId);
  const iterationPath = await resolveBugIterationPath(input.adapter, scope.azureProjectId, parentStory, input.iterationPath);
  const areaPath = optionalText(input.areaPath) ?? parentStory?.areaPath;
  const customFields = normalizeCustomFieldsForAzure(report.customFields, fieldMetadata);

  const created = await input.adapter.createBug({
    projectId: scope.azureProjectId,
    bug: {
      title: report.title,
      reproStepsHtml: buildReproStepsHtml(report),
      priority: report.priority,
      severity: report.severity,
      assignedTo: optionalText(input.assignedTo),
      areaPath,
      iterationPath,
      parentStoryId: parentStory?.id,
      customFields,
    },
  });

  if (!created.success || !created.azureBugId) {
    writeAuditLog({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      actor: input.actor,
      entityType: "work_item",
      entityId: input.parentStoryId,
      action: "azure_devops.create_bug",
      status: "Failed",
      message: "Azure DevOps bug creation failed.",
      details: { error: created.error, parentStoryId: input.parentStoryId },
    });
    throw new Error(created.error ?? "Azure DevOps bug creation failed.");
  }

  const attachmentResults = await attachFiles(input.adapter, scope.azureProjectId, created.azureBugId, input.attachments ?? []);
  const hasAttachmentFailures = attachmentResults.some((result) => !result.success);
  const webUrl = input.adapter.buildWorkItemWebUrl({
    projectId: scope.azureProjectId,
    projectName: scope.azureProjectName,
    workItemId: created.azureBugId,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    entityType: "work_item",
    entityId: created.azureBugId,
    action: "azure_devops.create_bug",
    status: hasAttachmentFailures ? "Partial failure" : "Success",
    message: hasAttachmentFailures
      ? `Created Azure DevOps Bug ${created.azureBugId}, but one or more attachments failed.`
      : `Created Azure DevOps Bug ${created.azureBugId}.`,
    details: {
      parentStoryId: parentStory?.id,
      assignedTo: input.assignedTo,
      iterationPath,
      areaPath,
      attachmentResults,
    },
  });

  return {
    bugId: created.azureBugId,
    webUrl,
    attachmentResults,
  } satisfies PostBugResult;
}

export function normalizeCustomFieldsForAzure(
  fields: BugCustomFieldValue[],
  metadata: AzureWorkItemTypeField[],
): AzureBugCustomField[] {
  const metadataByKey = new Map<string, AzureWorkItemTypeField>();
  for (const field of metadata) {
    metadataByKey.set(field.referenceName.toLowerCase(), field);
    metadataByKey.set(field.name.toLowerCase(), field);
  }

  const normalized = new Map<string, AzureBugCustomField>();
  for (const field of fields) {
    const metadataField = metadataByKey.get(field.referenceName.toLowerCase()) ?? (field.name ? metadataByKey.get(field.name.toLowerCase()) : undefined);
    const referenceName = metadataField?.referenceName ?? field.referenceName;
    if (reservedBugFieldReferences.has(referenceName) || readOnlyBugFieldReferences.has(referenceName)) continue;
    const value = coerceFieldValue(field.value, metadataField);
    if (value === undefined) continue;
    normalized.set(referenceName, { referenceName, value });
  }

  return [...normalized.values()];
}

export function findCurrentIterationPath(iterations: AzureIteration[], now = new Date()) {
  const current = iterations.find((iteration) => isCurrentIteration(iteration, now));
  if (current?.path) return current.path;

  const started = iterations
    .filter((iteration) => iteration.startDate && startOfLocalDay(iteration.startDate).getTime() <= now.getTime())
    .sort((a, b) => startOfLocalDay(b.startDate).getTime() - startOfLocalDay(a.startDate).getTime());
  return started[0]?.path ?? "";
}

async function fetchParentStory(adapter: AzureDevOpsAdapter, projectId: string, parentStoryId?: string) {
  const id = optionalText(parentStoryId);
  if (!id) return null;
  const parentStory = await adapter.fetchWorkItemById({ projectId, workItemId: id });
  if (parentStory.workItemType !== "User Story") {
    throw new Error(`Parent Story ID ${id} is a ${parentStory.workItemType}, not a User Story.`);
  }
  return parentStory;
}

async function resolveBugIterationPath(
  adapter: AzureDevOpsAdapter,
  projectId: string,
  parentStory: Requirement | null,
  requestedIterationPath?: string,
) {
  const requested = optionalText(requestedIterationPath);
  if (requested) return requested;
  const iterations = await adapter.fetchIterations({ projectId });
  return findCurrentIterationPath(iterations) || parentStory?.iterationPath || undefined;
}

async function attachFiles(
  adapter: AzureDevOpsAdapter,
  projectId: string,
  bugId: string,
  attachments: BugAttachmentInput[],
): Promise<BugAttachmentResult[]> {
  const results: BugAttachmentResult[] = [];
  for (const attachment of attachments) {
    const uploaded = await adapter.uploadWorkItemAttachment({ projectId, attachment });
    if (!uploaded.success || !uploaded.attachmentUrl) {
      results.push({ fileName: attachment.fileName, success: false, error: uploaded.error ?? "Attachment upload failed." });
      continue;
    }

    const linked = await adapter.attachFileToWorkItem({
      projectId,
      workItemId: bugId,
      attachmentUrl: uploaded.attachmentUrl,
      fileName: attachment.fileName,
    });
    results.push({
      fileName: attachment.fileName,
      success: linked.success,
      attachmentUrl: uploaded.attachmentUrl,
      error: linked.error,
    });
  }
  return results;
}

function buildReproStepsHtml(report: {
  precondition: string;
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
}) {
  const sections = [
    ["Precondition", report.precondition],
    ["Steps to Reproduce", report.stepsToReproduce],
    ["Expected Result", report.expectedResult],
    ["Actual Result", report.actualResult],
  ] as const;

  return sections
    .filter(([, value]) => optionalText(value))
    .map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong><br/>${formatMultilineHtml(value ?? "")}</div>`)
    .join("<br/>");
}

function coerceFieldValue(value: BugCustomFieldValue["value"], metadata?: AzureWorkItemTypeField): AzureWorkItemFieldValue | undefined {
  const allowed = metadata?.allowedValues ?? [];
  if (allowed.length) {
    const matched = allowed.find((allowedValue) => String(allowedValue).toLowerCase() === String(value).toLowerCase());
    if (matched !== undefined) return matched;
  }

  switch (metadata?.type) {
    case "integer":
    case "picklistInteger":
      return numberValue(value, true);
    case "double":
    case "picklistDouble":
      return numberValue(value, false);
    case "boolean":
      return booleanFieldValue(value);
    default:
      return value;
  }
}

function numberValue(value: BugCustomFieldValue["value"], integer: boolean) {
  if (typeof value === "number") return integer ? Math.trunc(value) : value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (integer ? Math.trunc(parsed) : parsed) : value;
}

function booleanFieldValue(value: BugCustomFieldValue["value"]) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return value;
}

function isCurrentIteration(iteration: AzureIteration, now: Date) {
  if (!iteration.startDate || !iteration.finishDate) return false;
  return startOfLocalDay(iteration.startDate).getTime() <= now.getTime() && now.getTime() <= endOfLocalDay(iteration.finishDate).getTime();
}

function startOfLocalDay(value?: string) {
  const date = value ? new Date(value) : new Date(0);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfLocalDay(value?: string) {
  const date = value ? new Date(value) : new Date(0);
  date.setHours(23, 59, 59, 999);
  return date;
}

function optionalText(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatMultilineHtml(value: string) {
  return escapeHtml(value).replace(/\r?\n/g, "<br/>");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const reservedBugFieldReferences = new Set([
  "System.Title",
  "System.State",
  "Microsoft.VSTS.TCM.ReproSteps",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.Common.Severity",
  "System.AssignedTo",
  "System.AreaPath",
  "System.AreaId",
  "System.IterationPath",
  "System.IterationId",
  "Microsoft.VSTS.Common.ValueArea",
]);

const readOnlyBugFieldReferences = new Set([
  "System.Id",
  "System.Rev",
  "System.TeamProject",
  "System.WorkItemType",
  "System.CreatedDate",
  "System.CreatedBy",
  "System.ChangedDate",
  "System.ChangedBy",
  "System.AreaId",
  "System.IterationId",
  "System.NodeName",
  "System.AttachedFileCount",
  "System.ExternalLinkCount",
  "System.HyperLinkCount",
  "System.RelatedLinkCount",
  "System.CommentCount",
  "System.Watermark",
]);
