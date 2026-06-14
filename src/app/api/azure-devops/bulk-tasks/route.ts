import { NextResponse } from "next/server";
import { z } from "zod";
import { createBulkTasks } from "@/modules/integrations/azure-devops/azure-devops-bulk-task.service";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

const MAX_TASK_TEMPLATES = 20;
const MAX_TASK_CREATIONS = 1000;

const TrimmedOptionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  z.string().min(1).optional(),
);

const EstimateSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!isValidEstimateText(trimmed)) return value;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number({ invalid_type_error: "Original estimate must be a non-negative whole number or decimal." }).finite("Original estimate must be a non-negative whole number or decimal.").nonnegative("Original estimate cannot be negative.").optional());

const TaskTemplateSchema = z.object({
  templateId: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().min(1, "Every task definition requires an ID."),
  ),
  title: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().min(1, "Every task title is required."),
  ),
  description: TrimmedOptionalStringSchema,
  assignedTo: TrimmedOptionalStringSchema,
  originalEstimate: EstimateSchema,
  copyEstimateToRemainingWork: z.boolean().default(true),
});

const TaskOverrideSchema = z.object({
  templateId: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().min(1, "Every task override requires a task definition ID."),
  ),
  assignedTo: TrimmedOptionalStringSchema,
  originalEstimate: EstimateSchema,
});

const TargetSchema = z.object({
  storyId: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().regex(/^\d+$/, "Story IDs must be numeric."),
  ),
  taskOverrides: z.array(TaskOverrideSchema).max(MAX_TASK_TEMPLATES).default([]),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  taskTemplates: z.array(TaskTemplateSchema)
    .min(1, "At least one task definition is required.")
    .max(MAX_TASK_TEMPLATES, `No more than ${MAX_TASK_TEMPLATES} task definitions are allowed.`),
  targets: z.array(TargetSchema).min(1, "At least one target story is required."),
}).superRefine((value, ctx) => {
  const seenTemplateIds = new Set<string>();
  const seenTitles = new Set<string>();
  for (const [index, template] of value.taskTemplates.entries()) {
    if (seenTemplateIds.has(template.templateId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taskTemplates", index, "templateId"],
        message: `Duplicate task definition ID ${template.templateId}.`,
      });
    }
    seenTemplateIds.add(template.templateId);

    const normalizedTitle = normalizeTitleForMatch(template.title);
    if (seenTitles.has(normalizedTitle)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taskTemplates", index, "title"],
        message: `Duplicate task title "${template.title}".`,
      });
    }
    seenTitles.add(normalizedTitle);
  }

  const seenStoryIds = new Set<string>();
  for (const [index, target] of value.targets.entries()) {
    if (seenStoryIds.has(target.storyId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets", index, "storyId"],
        message: `Duplicate story ID ${target.storyId}.`,
      });
    }
    seenStoryIds.add(target.storyId);

    const seenOverrideTemplateIds = new Set<string>();
    for (const [overrideIndex, override] of target.taskOverrides.entries()) {
      if (!seenTemplateIds.has(override.templateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", index, "taskOverrides", overrideIndex, "templateId"],
          message: `Task override references unknown task definition ID ${override.templateId}.`,
        });
      }
      if (seenOverrideTemplateIds.has(override.templateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", index, "taskOverrides", overrideIndex, "templateId"],
          message: `Duplicate override for task definition ID ${override.templateId} in story ${target.storyId}.`,
        });
      }
      seenOverrideTemplateIds.add(override.templateId);
    }
  }

  const requestedCount = value.taskTemplates.length * value.targets.length;
  if (requestedCount > MAX_TASK_CREATIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targets"],
      message: `This batch would create ${requestedCount} tasks. The maximum is ${MAX_TASK_CREATIONS}.`,
    });
  }
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Task title and at least one valid target story are required." },
      { status: 400 },
    );
  }

  const analyticsRunId = startWorkflowRun({
    scope: parsed.data.scope,
    workflowType: "bulk_task_creation",
    workItemId: "bulk-tasks",
  });
  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const result = await createBulkTasks(adapter, parsed.data.scope, {
      taskTemplates: parsed.data.taskTemplates,
      targets: parsed.data.targets,
    });
    if (result.created.length > 0) {
      completeWorkflowRun({
        scope: parsed.data.scope,
        runId: analyticsRunId,
        valueRealized: true,
        patch: {
          itemsGenerated: result.requestedCount,
          itemsSelected: result.requestedCount,
          itemsPublished: result.created.length,
          itemsRejected: result.failed.length,
          manualActionsAvoided: result.created.length,
        },
      });
    } else {
      failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: "No bulk tasks were created." });
    }
    return NextResponse.json({ ...result, analyticsRunId });
  } catch (error) {
    failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Bulk task creation failed." });
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Azure DevOps bulk task creation failed." },
      { status: 503 },
    );
  }
}

function isValidEstimateText(value: string) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function normalizeTitleForMatch(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
