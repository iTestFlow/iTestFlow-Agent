import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const SuiteMigrationRequestSchema = z.object({
  scope: ProjectScopeSchema,
  sourceProjectId: z.string().min(1),
  sourceTestPlanId: azureIdSchema("plan"),
  selectedSuiteIds: z.array(azureIdSchema("suite")).min(1, "Select at least one source suite."),
  targetProjectId: z.string().min(1),
  targetTestPlanId: azureIdSchema("plan"),
  targetParentSuiteId: azureIdSchema("suite"),
  operationMode: z.enum(["copy", "move"]).default("copy"),
  outcomeMode: z.enum(["none", "latestOutcome", "latestOutcomeAndTester"]).default("latestOutcomeAndTester"),
  overwriteTargetOutcomes: z.boolean().default(false),
  conflictStrategy: z.literal("renameWithMigratedSuffix").default("renameWithMigratedSuffix"),
}).superRefine((value, ctx) => {
  if (value.sourceProjectId !== value.scope.azureProjectId || value.targetProjectId !== value.scope.azureProjectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetProjectId"],
      message: "This release supports same-project test suite migration only.",
    });
  }
});

export const SuiteTreeRequestSchema = z.object({
  scope: ProjectScopeSchema,
  testPlanId: azureIdSchema("plan"),
});

export function azureIdSchema(kind: "plan" | "suite") {
  return z.string().min(1).transform((value, ctx) => {
    const id = extractAzureId(value, kind);
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Enter a valid Azure Test ${kind === "plan" ? "Plan" : "Suite"} ID or URL.`,
      });
      return z.NEVER;
    }

    return id;
  });
}

function extractAzureId(value: string, kind: "plan" | "suite") {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const queryPattern = kind === "plan" ? /[?&]planId=(\d+)/i : /[?&]suiteId=(\d+)/i;
  const pathPattern = kind === "plan" ? /\/plans\/(\d+)(?:\/|$|\?)/i : /\/suites\/(\d+)(?:\/|$|\?)/i;
  return trimmed.match(queryPattern)?.[1] ?? trimmed.match(pathPattern)?.[1];
}
