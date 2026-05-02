import { z } from "zod";
import { GeneratedTestCaseSchema } from "@/modules/test-case-design/schemas/test-case.schema";

export const ExistingTestCaseReviewFindingSchema = z.object({
  id: z.string(),
  category: z.enum([
    "Missing coverage",
    "Duplicate",
    "Weak steps",
    "Weak expected result",
    "Missing preconditions",
    "Missing test data",
    "Automation readiness",
  ]),
  severity: z.enum(["High", "Medium", "Low"]),
  title: z.string(),
  explanation: z.string(),
  relatedTestCaseIds: z.array(z.string()).default([]),
  suggestedAction: z.string(),
});

export const ExistingTestCaseReviewOutputSchema = z.object({
  summary: z.string(),
  findings: z.array(ExistingTestCaseReviewFindingSchema),
  suggestedAdditions: z.array(GeneratedTestCaseSchema),
});

export type ExistingTestCaseReviewOutput = z.infer<typeof ExistingTestCaseReviewOutputSchema>;
