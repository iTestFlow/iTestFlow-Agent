import { z } from "zod";
import { ContextUsedSchema } from "@/modules/llm/context-used";

export const BugSeveritySchema = z.preprocess(
  normalizeBugSeverity,
  z.enum(["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]),
);
export const BugPrioritySchema = z.preprocess(
  normalizeBugPriority,
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
);

export const BugCustomFieldValueSchema = z.object({
  referenceName: z.string().trim().min(1),
  name: z.string().trim().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const BugAttachmentDescriptorSchema = z.object({
  fileName: z.string().trim().min(1),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export const GeneratedBugReportSchema = z.object({
  title: z.string().trim().min(1).max(140),
  precondition: z.string().trim().min(1),
  stepsToReproduce: z.string().trim().min(1),
  expectedResult: z.string().trim().min(1),
  actualResult: z.string().trim().min(1),
  systemInfo: z.string().trim().default("Not specified"),
  severity: BugSeveritySchema,
  severityRationale: z.string().trim().optional().default(""),
  priority: BugPrioritySchema,
  priorityRationale: z.string().trim().optional().default(""),
  environment: z.string().trim().optional().default("2. Testing/QC"),
  category: z.string().trim().optional().default("Functional"),
  customFields: z.array(BugCustomFieldValueSchema).optional().default([]),
  contextUsed: ContextUsedSchema,
});

export const FinalBugReportSchema = GeneratedBugReportSchema.extend({
  title: z.string().trim().min(1).max(200),
});

export type BugSeverity = z.infer<typeof BugSeveritySchema>;
export type BugCustomFieldValue = z.infer<typeof BugCustomFieldValueSchema>;
export type BugAttachmentDescriptor = z.infer<typeof BugAttachmentDescriptorSchema>;
export type GeneratedBugReport = z.infer<typeof GeneratedBugReportSchema>;
export type FinalBugReport = z.infer<typeof FinalBugReportSchema>;

function normalizeBugPriority(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (value === 1 || normalized === "1" || normalized === "1 - highest" || normalized === "highest" || normalized === "1 - critical" || normalized === "1 - high") return 1;
  if (value === 2 || normalized === "2" || normalized === "2 - medium" || normalized === "medium" || normalized === "2 - high" || normalized === "2 - current sprint") return 2;
  if (value === 3 || normalized === "3" || normalized === "3 - low" || normalized === "low" || normalized === "3 - medium" || normalized === "3 - soon") return 3;
  if (value === 4 || normalized === "4" || normalized === "4 - lowest" || normalized === "lowest" || normalized === "4 - low" || normalized === "4 - when possible") return 4;
  return value;
}

function normalizeBugSeverity(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (value === 1 || normalized === "1" || normalized === "critical" || normalized === "1 - critical") return "1 - Critical";
  if (value === 2 || normalized === "2" || normalized === "high" || normalized === "2 - high") return "2 - High";
  if (value === 3 || normalized === "3" || normalized === "medium" || normalized === "3 - medium" || normalized === "3 - medium (default)") return "3 - Medium";
  if (value === 4 || normalized === "4" || normalized === "low" || normalized === "4 - low") return "4 - Low";
  return value;
}
