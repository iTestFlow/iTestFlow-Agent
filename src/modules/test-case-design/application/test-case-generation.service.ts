import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { truncationAuditDetails } from "@/modules/llm/llm-warnings";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMImageInput, LLMProvider } from "@/modules/llm/llm-types";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import { estimateTokens, usableInputTokens } from "@/modules/llm/token-estimate";
import { AppErrorCode } from "@/modules/shared/errors/app-error";
import { AcceptanceCriteriaError, buildAcceptanceCriteriaContract, type AcceptanceCriteriaContract } from "../acceptance-criteria-contract";
import { evaluateAcceptanceCriteriaCoverage } from "../acceptance-criteria-coverage";
import {
  buildTestCaseGenerationMarkdownPrompt,
  extractWorkItemId,
  type StoryAttachmentPromptContext,
} from "@/modules/llm/markdown-prompt-renderer";
import { buildTestCaseGenerationSystemPrompt, testCaseGenerationPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { normalizeTestDesignOptions, type TestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestCaseGenerationOutputSchema, type TestCaseGenerationOutput } from "../schemas/test-case.schema";

function requireCoverage(contract: AcceptanceCriteriaContract, output: TestCaseGenerationOutput) {
  const coverage = evaluateAcceptanceCriteriaCoverage(contract, output);
  if (coverage.missingCriteria.length || coverage.unknownReferences.length) {
    throw new AcceptanceCriteriaError(
      AppErrorCode.AcceptanceCriteriaCoverage,
      `Acceptance criteria mapping is incomplete: ${coverage.coveredCount} of ${coverage.requiredCount} AC IDs mapped. Add missing IDs and remove unknown references.`,
      { coverage },
    );
  }
  return coverage;
}

function checkInputBudget(system: string, user: string, maxInputTokens?: number) {
  if (estimateTokens(`${system}\n${user}`) > usableInputTokens(maxInputTokens)) {
    throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaInputBudget,
      "The complete acceptance criteria and prompt exceed the model input budget. Select a larger model or shorten supporting context; required criteria cannot be truncated.");
  }
}

export async function generateTestCases(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  /** Model window, so the prompt can size compiled knowledge and related context to it. */
  maxInputTokens?: number;
  /** Workspace retrieval top-K, honoured as a floor for related work items. */
  relatedWorkItemsFloor?: number;
  /** Semantic ordering of knowledge entries; overrides keyword ranking when supplied. */
  rankedKnowledgeKeys?: Record<string, string[]>;
  projectKnowledgeNotice?: string | null;
  storyAttachments?: StoryAttachmentPromptContext[];
  attachmentImages?: readonly LLMImageInput[];
  options?: Partial<TestDesignOptions>;
  extraInstructions?: string;
  preparedPromptDraft?: ReturnType<typeof buildTestCaseGenerationPromptDraft>;
  signal?: AbortSignal;
}) {
  const scope = assertProjectScope(input.scope);
  const promptDraft = input.preparedPromptDraft ?? buildTestCaseGenerationPromptDraft({
    scope,
    // Sizes how much compiled knowledge and related context the prompt carries.
    maxInputTokens: input.maxInputTokens,
    relatedWorkItemsFloor: input.relatedWorkItemsFloor,
    rankedKnowledgeKeys: input.rankedKnowledgeKeys,
    targetRequirement: input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    storyAttachments: input.storyAttachments,
    options: input.options,
    extraInstructions: input.extraInstructions,
  });
  const contract = buildAcceptanceCriteriaContract(input.targetRequirement);
  checkInputBudget(promptDraft.systemPrompt, promptDraft.userPrompt, input.maxInputTokens);
  let rejected: { validatedOutput: TestCaseGenerationOutput; rawOutput: string } | undefined;
  const request = {
    schemaName: promptDraft.schemaName,
    schema: TestCaseGenerationOutputSchema,
    system: promptDraft.systemPrompt,
    user: promptDraft.userPrompt,
    images: input.attachmentImages,
    signal: input.signal,
    validateOutput: ({ validatedOutput, rawOutput }: { validatedOutput: TestCaseGenerationOutput; rawOutput: string }) => {
      rejected = { validatedOutput, rawOutput };
      requireCoverage(contract, validatedOutput);
    },
    metadata: {
      action: "test_case_generation.run",
      promptName: testCaseGenerationPrompt.name,
      promptVersion: testCaseGenerationPrompt.version,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      targetWorkItemId: extractWorkItemId(input.targetRequirement),
    },
  };
  let result;
  let correctionAttempts = 0;
  try {
    result = await input.provider.generateStructuredOutput(request);
    rejected = { validatedOutput: result.validatedOutput, rawOutput: result.rawOutput };
    requireCoverage(contract, result.validatedOutput);
  } catch (error) {
    if (!(error instanceof AcceptanceCriteriaError) || error.code !== AppErrorCode.AcceptanceCriteriaCoverage) throw error;
    if (input.signal?.aborted) throw error;
    if (!rejected) throw error;
    correctionAttempts = 1;
    const correctionPrompt = [
      promptDraft.userPrompt,
      "# Correct the rejected output",
      "Return a complete replacement JSON response using the original story and all required AC IDs. Fix these exact mapping errors:",
      JSON.stringify(error.details?.coverage),
      "Rejected candidate (repair this, keeping valid cases where possible):",
      rejected.rawOutput,
    ].join("\n\n");
    checkInputBudget(promptDraft.systemPrompt, correctionPrompt, input.maxInputTokens);
    result = await input.provider.generateStructuredOutput({ ...request, user: correctionPrompt, redactRequestLog: true });
    requireCoverage(contract, result.validatedOutput);
  }
  const acceptanceCriteriaCoverage = requireCoverage(contract, result.validatedOutput);

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "test_case_generation.run",
    status: "Success",
    message: `Generated ${result.validatedOutput.testCases.length} validated test cases.`,
    details: {
      ...truncationAuditDetails(result.warnings),
      provider: result.provider,
      model: result.model,
      promptVersion: testCaseGenerationPrompt.version,
      testDesignOptions: promptDraft.testDesignOptions,
      acceptanceCriteriaCoverage: { requiredCount: acceptanceCriteriaCoverage.requiredCount, coveredCount: acceptanceCriteriaCoverage.coveredCount, correctionAttempts },
    },
  });

  return {
    ...result,
    acceptanceCriteriaContract: contract,
    acceptanceCriteriaCoverage,
    correctionAttempts,
    relevantProjectKnowledgeBase: promptDraft.relevantProjectKnowledgeBase,
    includedStoryAttachmentTextIds: promptDraft.includedStoryAttachmentTextIds,
    omittedStoryAttachmentTextIds: promptDraft.omittedStoryAttachmentTextIds,
    warnings: mergeWarnings(result.warnings, promptDraft.storyAttachmentWarnings),
  };
}

export function buildTestCaseGenerationPromptDraft(input: {
  scope: ProjectScope;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  /** Model window, so the prompt can size compiled knowledge and related context to it. */
  maxInputTokens?: number;
  /** Workspace retrieval top-K, honoured as a floor for related work items. */
  relatedWorkItemsFloor?: number;
  /** Semantic ordering of knowledge entries; overrides keyword ranking when supplied. */
  rankedKnowledgeKeys?: Record<string, string[]>;
  projectKnowledgeNotice?: string | null;
  storyAttachments?: StoryAttachmentPromptContext[];
  options?: Partial<TestDesignOptions>;
  extraInstructions?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const acceptanceCriteriaContract = buildAcceptanceCriteriaContract(input.targetRequirement);
  const testDesignOptions = normalizeTestDesignOptions(input.options);
  const systemPrompt = buildTestCaseGenerationSystemPrompt(input.options);
  const promptPayload = buildTestCaseGenerationMarkdownPrompt({
    // Sizes how much compiled knowledge and related context the prompt carries.
    maxInputTokens: input.maxInputTokens,
    relatedWorkItemsFloor: input.relatedWorkItemsFloor,
    rankedKnowledgeKeys: input.rankedKnowledgeKeys,
    currentProject: {
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
    },
    targetRequirement: input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    storyAttachments: input.storyAttachments,
    options: testDesignOptions,
    extraInstructions: input.extraInstructions,
    outputContract: testCaseOutputContract,
  });

  const inventory = [
    "# Required Acceptance Criteria Contract",
    `Version: ${acceptanceCriteriaContract.version}`,
    ...acceptanceCriteriaContract.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
    "Every ID above must appear in at least one test case's relatedAcceptanceCriteria. Use only these canonical IDs. Supplemental cases may have no AC reference.",
    "The target case-count range is a target and may be exceeded to map every AC ID.",
  ].join("\n");
  const userPrompt = `${promptPayload.prompt}\n\n${inventory}`;
  checkInputBudget(systemPrompt, userPrompt, input.maxInputTokens);

  return {
    schemaName: "TestCaseGenerationOutput",
    promptName: testCaseGenerationPrompt.name,
    promptVersion: testCaseGenerationPrompt.version,
    systemPrompt,
    userPrompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Test Case Design",
      system: systemPrompt,
      user: userPrompt,
    }),
    acceptanceCriteriaContract,
    testDesignOptions,
    relevantProjectKnowledgeBase: promptPayload.relevantProjectKnowledgeBase,
    includedStoryAttachmentTextIds: promptPayload.includedStoryAttachmentTextIds,
    omittedStoryAttachmentTextIds: promptPayload.omittedStoryAttachmentTextIds,
    storyAttachmentWarnings: promptPayload.storyAttachmentWarnings,
  };
}

function mergeWarnings(...warningGroups: Array<string[] | undefined>) {
  const warnings = warningGroups.flatMap((group) => group ?? []).filter((warning) => warning.trim().length > 0);
  return warnings.length ? warnings : undefined;
}

export function completeManualTestCaseGeneration(input: {
  scope: ProjectScope;
  actor: string;
  rawOutput: string;
  targetWorkItemId?: string;
  acceptanceCriteriaContract: AcceptanceCriteriaContract;
}) {
  const scope = assertProjectScope(input.scope);
  const validatedOutput = parseExternalStructuredOutput({
    schemaName: "TestCaseGenerationOutput",
    schema: TestCaseGenerationOutputSchema,
    rawOutput: input.rawOutput,
  });
  const acceptanceCriteriaCoverage = requireCoverage(input.acceptanceCriteriaContract, validatedOutput);

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "test_case_generation.manual_complete",
    status: "Success",
    message: `Generated ${validatedOutput.testCases.length} validated test cases from external LLM output.`,
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: testCaseGenerationPrompt.version,
      targetWorkItemId: input.targetWorkItemId,
      acceptanceCriteriaCoverage: { requiredCount: acceptanceCriteriaCoverage.requiredCount, coveredCount: acceptanceCriteriaCoverage.coveredCount },
    },
  });

  return {
    provider: "external",
    model: "manual-external",
    rawOutput: input.rawOutput,
    validatedOutput,
    acceptanceCriteriaContract: input.acceptanceCriteriaContract,
    acceptanceCriteriaCoverage,
  };
}

const testCaseOutputContract = {
  testCases: [
    {
      id: "TC-MODULE-001",
      title: "Validate clear behavior",
      description: "Brief description of what the test validates",
      priority: "number only: 1|2|3|4, where 1 is highest and 4 is lowest",
      type: "execution type only: functional|smoke|sanity|regression|e2e|integration|unit|api|ui|security|performance|accessibility; never use a Coverage Focus value such as data-validation",
      category: "happy_path|negative|edge|boundary|integration|workflow|security|accessibility",
      tags: ["string"],
      relatedAcceptanceCriteria: ["AC-001"],
      relatedBusinessRules: ["module/section/rule reference"],
      relatedModules: ["module-id"],
      preconditions: "Detailed setup requirements",
      testData: "Realistic data, if applicable",
      steps: [
        {
          stepNumber: 1,
          action: "Preconditions:\n1. Required setup is available",
          expectedResult: "Preconditions are met",
        },
        {
          stepNumber: 2,
          action: "Specific tester action",
          expectedResult: "Specific measurable expected result",
        },
      ],
    },
  ],
  summary: {
    totalCases: 0,
    byType: { regression: 0 },
    byPriority: { "1": 0 },
    coverageEstimate: 0,
  },
  contextUsed: ["source IDs only, such as module-id or work-item-id"],
};
