import { NextResponse } from "next/server";
import { z } from "zod";
import { createBulkTasks } from "@/modules/integrations/azure-devops/azure-devops-bulk-task.service";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

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

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  template: z.object({
    title: z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().min(1, "Task title is required.")),
    description: TrimmedOptionalStringSchema,
    assignedTo: TrimmedOptionalStringSchema,
    originalEstimate: EstimateSchema,
    copyEstimateToRemainingWork: z.boolean().default(true),
  }),
  tasks: z.array(z.object({
    storyId: z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().regex(/^\d+$/, "Story IDs must be numeric.")),
    assignedTo: TrimmedOptionalStringSchema,
    originalEstimate: EstimateSchema,
  })).min(1, "At least one target story is required."),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (seen.has(task.storyId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tasks", index, "storyId"],
        message: `Duplicate story ID ${task.storyId}.`,
      });
    }
    seen.add(task.storyId);
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

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const result = await createBulkTasks(adapter, parsed.data.scope, {
      template: parsed.data.template,
      tasks: parsed.data.tasks,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Azure DevOps bulk task creation failed." },
      { status: 503 },
    );
  }
}

function sanitizeAzureError(value: string) {
  return value
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{20,}/g, "Basic [redacted]")
    .replace(/personalAccessToken["'\s:=]+[^"',\s}]+/gi, "personalAccessToken: [redacted]")
    .replace(/pat["'\s:=]+[^"',\s}]+/gi, "PAT: [redacted]");
}

function isValidEstimateText(value: string) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}
