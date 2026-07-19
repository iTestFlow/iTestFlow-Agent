import "server-only";

import { z } from "zod";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { truncationAuditDetails } from "@/modules/llm/llm-warnings";
import type { TestCase } from "@/modules/integrations/azure-devops/azure-devops-types";
import { parseExternalJson } from "@/modules/llm/external-structured-output";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import { buildTestExecutionEffortMarkdownPrompt, extractWorkItemId } from "@/modules/llm/markdown-prompt-renderer";
import { testExecutionEffortPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  TEST_EXECUTION_EFFORT_OUTPUT_CONTRACT,
  TestExecutionEffortOptionsSchema,
  TestExecutionEffortOutputSchema,
  type TestExecutionEffortOptions,
} from "./test-execution-effort.schema";

export const NO_LINKED_TEST_CASES_MESSAGE =
  "No linked test cases were found for this story. Execution effort cannot be estimated without test cases.";

const REQUIREMENT_LIKE_WORK_ITEM_TYPES = new Set([
  "user story",
  "product backlog item",
  "requirement",
  "feature",
  "bug",
]);

type RequirementLike = {
  id?: string;
  title?: string;
  workItemType?: string;
  state?: string;
  areaPath?: string;
  iterationPath?: string;
};

export async function generateTestExecutionEffort(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  targetRequirement: unknown;
  linkedTestCases: TestCase[];
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  projectKnowledgeNotice?: string | null;
  options: TestExecutionEffortOptions;
}) {
  const scope = assertProjectScope(input.scope);
  assertLinkedTestCasesExist(input.linkedTestCases);
  const promptDraft = buildTestExecutionEffortPromptDraft({
    scope,
    targetRequirement: input.targetRequirement,
    linkedTestCases: input.linkedTestCases,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    options: input.options,
  });

  const result = await input.provider.generateStructuredOutput({
    schemaName: promptDraft.schemaName,
    schema: TestExecutionEffortOutputSchema,
    system: promptDraft.systemPrompt,
    user: promptDraft.userPrompt,
    metadata: {
      action: "test_execution_effort.run",
      promptName: testExecutionEffortPrompt.name,
      promptVersion: testExecutionEffortPrompt.version,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      targetWorkItemId: extractWorkItemId(input.targetRequirement),
    },
  });
  assertEstimateCoversLinkedTestCases(result.validatedOutput, input.linkedTestCases);

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "test_execution_effort.run",
    status: "Success",
    message: `Generated a manual execution effort estimate for ${input.linkedTestCases.length} linked test cases.`,
    details: {
      ...truncationAuditDetails(result.warnings),
      provider: result.provider,
      model: result.model,
      promptVersion: testExecutionEffortPrompt.version,
      options: input.options,
    },
  });

  return {
    ...result,
    relevantProjectKnowledgeBase: promptDraft.relevantProjectKnowledgeBase,
  };
}

export function buildTestExecutionEffortPromptDraft(input: {
  scope: ProjectScope;
  targetRequirement: unknown;
  linkedTestCases: TestCase[];
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  projectKnowledgeNotice?: string | null;
  options: TestExecutionEffortOptions;
}) {
  const scope = assertProjectScope(input.scope);
  assertLinkedTestCasesExist(input.linkedTestCases);
  const promptPayload = buildTestExecutionEffortPrompt({
    scope,
    targetRequirement: input.targetRequirement,
    linkedTestCases: input.linkedTestCases,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    options: input.options,
  });

  return {
    schemaName: "TestExecutionEffortOutput",
    promptName: testExecutionEffortPrompt.name,
    promptVersion: testExecutionEffortPrompt.version,
    systemPrompt: testExecutionEffortPrompt.system,
    userPrompt: promptPayload.prompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Test Execution Effort",
      system: testExecutionEffortPrompt.system,
      user: promptPayload.prompt,
    }),
    relevantProjectKnowledgeBase: promptPayload.relevantProjectKnowledgeBase,
  };
}

export function buildTestExecutionEffortPrompt(input: {
  scope: ProjectScope;
  targetRequirement: unknown;
  linkedTestCases: TestCase[];
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  projectKnowledgeNotice?: string | null;
  options: TestExecutionEffortOptions;
}) {
  const scope = assertProjectScope(input.scope);
  return buildTestExecutionEffortMarkdownPrompt({
    currentProject: {
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
    },
    targetRequirement: input.targetRequirement,
    linkedTestCases: input.linkedTestCases,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    options: TestExecutionEffortOptionsSchema.parse(input.options),
    outputContract: TEST_EXECUTION_EFFORT_OUTPUT_CONTRACT,
  });
}

export function completeManualTestExecutionEffort(input: {
  scope: ProjectScope;
  actor: string;
  rawOutput: string;
  targetWorkItemId?: string;
  linkedTestCases?: TestCase[];
}) {
  const scope = assertProjectScope(input.scope);
  const schemaName = "TestExecutionEffortOutput";
  const parsedJson = parseExternalJson(input.rawOutput, {
    provider: "external",
    model: "manual-external",
    schemaName,
  });
  const candidate = unwrapEstimateOutput(parsedJson);
  const parsedOutput = TestExecutionEffortOutputSchema.safeParse(candidate);
  if (!parsedOutput.success) {
    throw new AppError({
      code: AppErrorCode.SchemaValidation,
      message: `External LLM output failed schema validation for ${schemaName}: ${formatZodIssues(parsedOutput.error)}`,
      userMessage: "The external LLM response did not match the expected format. Check the pasted response and try again.",
      technicalContext: {
        provider: "external",
        model: "manual-external",
        schemaName,
        rawOutputExcerpt: input.rawOutput,
      },
    });
  }
  const validatedOutput = parsedOutput.data;
  if (input.linkedTestCases) {
    assertEstimateCoversLinkedTestCases(validatedOutput, input.linkedTestCases);
  }

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "test_execution_effort.manual_complete",
    status: "Success",
    message: "Test Execution Effort completed from validated external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: testExecutionEffortPrompt.version,
      targetWorkItemId: input.targetWorkItemId,
    },
  });

  return {
    provider: "external",
    model: "manual-external",
    rawOutput: input.rawOutput,
    validatedOutput,
  };
}

export function buildTestExecutionEffortPreview(input: {
  targetRequirement: unknown;
  linkedTestCases: TestCase[];
  hasProjectContext: boolean;
}) {
  const story = toStorySummary(input.targetRequirement);
  const totalSteps = input.linkedTestCases.reduce((total, testCase) => total + (testCase.steps?.length ?? 0), 0);
  const testCasesWithMissingSteps = input.linkedTestCases.filter((testCase) => !testCase.steps?.length).length;
  const workItemTypeWarning = isRequirementLikeWorkItem(story.workItemType)
    ? undefined
    : `The selected work item type is "${story.workItemType || "Unknown"}". Estimation is allowed because linked test cases were found.`;

  return {
    story,
    summary: {
      linkedTestCaseCount: input.linkedTestCases.length,
      totalSteps,
      testCasesWithMissingSteps,
      hasProjectContext: input.hasProjectContext,
      workItemTypeWarning,
    },
    testCases: input.linkedTestCases.map((testCase) => ({
      id: testCase.azureTestCaseId ?? testCase.id,
      title: testCase.title,
      stepsCount: testCase.steps?.length ?? 0,
      hasMissingSteps: !testCase.steps?.length,
    })),
  };
}

export function normalizeTestExecutionEffortOptions(options: unknown) {
  return TestExecutionEffortOptionsSchema.parse(options);
}

export function toSafeTestExecutionEffortError(error: unknown, fallback: string, storyId?: string) {
  const message = error instanceof Error ? error.message : "";
  if (message === NO_LINKED_TEST_CASES_MESSAGE) {
    return { status: 400, message };
  }
  if (message.includes("Azure DevOps is not configured")) {
    return { status: 503, message };
  }
  if (message.includes("No LLM provider configured")) {
    return { status: 503, message };
  }
  if (message.includes("Missing testCaseEstimates rows") || message.includes("every linked test case")) {
    return { status: 422, message };
  }
  if (message.includes("404") || message.includes("TF401232") || message.includes("WorkItemUnauthorizedAccessException")) {
    return {
      status: 503,
      message: `Work item ${storyId ?? ""} was not found, or your Azure DevOps account does not have permission to read it. Check the ID and selected project.`.trim(),
    };
  }
  if (message.includes("401") || message.includes("403")) {
    return {
      status: 503,
      message: "Azure DevOps rejected the request. Check that your connection settings and permissions allow reading work items and linked test cases.",
    };
  }
  if (message.includes("rate") || message.includes("quota") || message.includes("429")) {
    return {
      status: 503,
      message: "The configured LLM provider is temporarily rate-limited or out of quota. Try again later or use External LLM Prompt mode.",
    };
  }
  return { status: 503, message: fallback };
}

function assertLinkedTestCasesExist(linkedTestCases: TestCase[]) {
  if (!linkedTestCases.length) {
    throw new Error(NO_LINKED_TEST_CASES_MESSAGE);
  }
}

function assertEstimateCoversLinkedTestCases(
  output: z.infer<typeof TestExecutionEffortOutputSchema>,
  linkedTestCases: TestCase[],
) {
  const expectedIds = new Set(linkedTestCases.map(getLinkedTestCaseId).filter(Boolean));
  if (!expectedIds.size) return;

  const returnedIds = new Set(output.testCaseEstimates.map((row) => row.testCaseId.trim()).filter(Boolean));
  const missingIds = [...expectedIds].filter((id) => !returnedIds.has(id));
  if (!missingIds.length) return;

  const preview = missingIds.slice(0, 20).join(", ");
  const remaining = missingIds.length > 20 ? `, and ${missingIds.length - 20} more` : "";
  throw new Error(
    `The LLM returned estimates for ${returnedIds.size} of ${expectedIds.size} linked test cases. Missing testCaseEstimates rows for: ${preview}${remaining}. Return one testCaseEstimates entry for every linked test case.`,
  );
}

function getLinkedTestCaseId(testCase: TestCase) {
  return String(testCase.azureTestCaseId ?? testCase.id ?? "").trim();
}

function unwrapEstimateOutput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const objectValue = value as Record<string, unknown>;
  if (!("estimate" in objectValue)) return value;

  const directResult = TestExecutionEffortOutputSchema.safeParse(value);
  if (directResult.success) return value;

  return objectValue.estimate;
}

function formatZodIssues(error: z.ZodError) {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const remaining = error.issues.length - issues.length;
  return remaining > 0 ? `${issues.join("; ")}; and ${remaining} more issue(s).` : issues.join("; ");
}

function toStorySummary(value: unknown) {
  const item = value && typeof value === "object" ? value as RequirementLike : {};
  return {
    id: item.id ? String(item.id) : extractWorkItemId(value) ?? "",
    title: item.title ?? "Untitled work item",
    workItemType: item.workItemType ?? "Unknown",
    state: item.state ?? "Unknown",
    areaPath: item.areaPath,
    iterationPath: item.iterationPath,
  };
}

function isRequirementLikeWorkItem(workItemType: string) {
  return REQUIREMENT_LIKE_WORK_ITEM_TYPES.has(workItemType.trim().toLowerCase());
}
