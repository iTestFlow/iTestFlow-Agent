import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkflowContext: vi.fn(),
  resolveWorkflowContextWithoutLLM: vi.fn(),
  resolveRetrievalTopK: vi.fn(),
  loadProjectKnowledgeContext: vi.fn(),
  rankProjectKnowledgeForWorkItem: vi.fn(),
  loadSelectedStoryAttachmentWorkflowContext: vi.fn(),
  buildRequirementAnalysisPromptDraft: vi.fn(),
  buildTestCaseGenerationPromptDraft: vi.fn(),
  buildExistingTestCaseReviewPromptDraft: vi.fn(),
}));

vi.mock("./auto-context-resolver.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("./auto-context-resolver.service")>(),
  resolveWorkflowContext: mocks.resolveWorkflowContext,
  resolveWorkflowContextWithoutLLM: mocks.resolveWorkflowContextWithoutLLM,
}));
vi.mock("./retrieval-config", () => ({
  resolveRetrievalTopK: mocks.resolveRetrievalTopK,
}));
vi.mock("./project-knowledge.service", () => ({
  loadProjectKnowledgeContext: mocks.loadProjectKnowledgeContext,
}));
vi.mock("./knowledge-relevance.service", () => ({
  rankProjectKnowledgeForWorkItem: mocks.rankProjectKnowledgeForWorkItem,
}));
vi.mock("@/modules/story-attachments/story-attachment-workflow-context", () => ({
  loadSelectedStoryAttachmentWorkflowContext: mocks.loadSelectedStoryAttachmentWorkflowContext,
}));
vi.mock("@/modules/requirement-analysis/application/requirement-analysis.service", () => ({
  buildRequirementAnalysisPromptDraft: mocks.buildRequirementAnalysisPromptDraft,
}));
vi.mock("@/modules/test-case-design/application/test-case-generation.service", () => ({
  buildTestCaseGenerationPromptDraft: mocks.buildTestCaseGenerationPromptDraft,
}));
vi.mock("@/modules/existing-test-case-review/application/existing-test-case-review.service", () => ({
  buildExistingTestCaseReviewPromptDraft: mocks.buildExistingTestCaseReviewPromptDraft,
}));

import { fakeAzureAdapter, fakeLlmProvider, projectScope, requirement, testCase } from "@/test/factories";
import { ProjectKnowledgeBaseSchema } from "./project-knowledge.schema";
import { ReviewedContextSourceUnavailableError } from "./auto-context-resolver.service";
import { StoryAttachmentNotReadyError } from "@/modules/story-attachments/story-attachments.service";
import {
  ContextReviewRequiredError,
  prepareWorkflowContext,
  type WorkflowContextWorkflow,
} from "./workflow-context-preparation.service";

const scope = projectScope();
const targetRequirement = requirement({ id: "101", title: "Target story" });

const emptyContext = {
  relatedWorkItems: [],
  selectedContext: [],
  contextUsed: [],
  retrievalTopK: 6,
};

function input(workflow: WorkflowContextWorkflow, overrides: Record<string, unknown> = {}) {
  return {
    workflow,
    mode: "auto" as const,
    scope,
    actor: "tester@example.com",
    adapter: fakeAzureAdapter({
      fetchLinkedTestCases: vi.fn(async () => [testCase({ id: "primary-test-case" })]),
    }),
    provider: fakeLlmProvider(),
    workspaceId: "workspace-1",
    workspaceProviderId: "azure-devops" as const,
    targetRequirement,
    ...overrides,
  };
}

function draft(inputValue: { projectKnowledgeBase?: unknown | null }) {
  return {
    prompt: "Prepared prompt",
    userPrompt: "Prepared user prompt",
    relevantProjectKnowledgeBase: inputValue.projectKnowledgeBase ?? null,
    includedStoryAttachmentTextIds: [],
    omittedStoryAttachmentTextIds: [],
    storyAttachmentWarnings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRetrievalTopK.mockResolvedValue(6);
  mocks.resolveWorkflowContext.mockResolvedValue(emptyContext);
  mocks.resolveWorkflowContextWithoutLLM.mockResolvedValue(emptyContext);
  mocks.loadProjectKnowledgeContext.mockResolvedValue({ knowledgeBase: null, promptNotice: null });
  mocks.rankProjectKnowledgeForWorkItem.mockResolvedValue(null);
  mocks.loadSelectedStoryAttachmentWorkflowContext.mockResolvedValue({
    promptAttachments: [],
    citationAttachments: [],
    images: [],
    imageTokenReserve: 0,
    effectivePromptInputTokens: 32_000,
    warnings: [],
  });
  mocks.buildRequirementAnalysisPromptDraft.mockImplementation(draft);
  mocks.buildTestCaseGenerationPromptDraft.mockImplementation(draft);
  mocks.buildExistingTestCaseReviewPromptDraft.mockImplementation(draft);
});

describe("prepareWorkflowContext", () => {
  it.each<WorkflowContextWorkflow>([
    "requirement_analysis",
    "test_case_generation",
    "existing_test_case_review",
  ])("does not make a generative call while previewing %s", async (workflow) => {
    const provider = fakeLlmProvider();

    await prepareWorkflowContext(input(workflow, { preview: true, provider }));

    expect(mocks.resolveWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.resolveWorkflowContextWithoutLLM).toHaveBeenCalledOnce();
    expect(provider.generateStructuredOutput).not.toHaveBeenCalled();
  });

  it("allows dependent knowledge to disappear with its removed story while retaining the reviewed set", async () => {
    const relatedStory = {
      sourceType: "azure_work_item" as const,
      workItemId: "200",
      workItemType: "User Story",
      state: "Active",
      title: "Related checkout story",
      content: "Context from story 200",
      relevanceScore: 0.9,
      metadata: { chunkIndex: 0 },
    };
    mocks.resolveWorkflowContextWithoutLLM.mockResolvedValue({
      relatedWorkItems: [relatedStory],
      selectedContext: [relatedStory],
      contextUsed: [{
        workItemId: "200",
        workItemType: "User Story",
        title: "Related checkout story",
        relevanceScore: 0.9,
        source: "linked_requirement",
      }],
      retrievalTopK: 6,
    });
    mocks.loadProjectKnowledgeContext.mockResolvedValue({
      knowledgeBase: ProjectKnowledgeBaseSchema.parse({
        modules: [],
        businessRules: [{
          id: "approval-rule",
          rule: "Approval is required.",
          sourceField: "description",
          sourceWorkItemIds: ["200"],
          evidence: "Story 200",
        }],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
        chatInsights: [],
      }),
      promptNotice: null,
    });

    const prepared = await prepareWorkflowContext(input("requirement_analysis", {
      preview: true,
      attachmentIds: ["attachment-1"],
      reviewedSourceIds: ["WI:200", "KB:business_rule:approval-rule", "SA:attachment-1"],
      excludedSourceIds: ["WI:200", "SA:attachment-1"],
    }));

    expect(prepared.contextCitations).toEqual([]);
    expect(prepared.implicitlyExcludedSourceIds).toEqual(["KB:business_rule:approval-rule"]);
    expect(mocks.loadSelectedStoryAttachmentWorkflowContext).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: [],
    }));
    expect(mocks.buildRequirementAnalysisPromptDraft).toHaveBeenCalledWith(expect.objectContaining({
      relatedWorkItems: [],
      selectedContext: [],
      projectKnowledgeBase: expect.objectContaining({ businessRules: [] }),
    }));
  });

  it("requires a refreshed review if a retained source no longer prepares", async () => {
    await expect(prepareWorkflowContext(input("test_case_generation", {
      preview: true,
      reviewedSourceIds: ["WI:404"],
      excludedSourceIds: [],
    }))).rejects.toBeInstanceOf(ContextReviewRequiredError);
  });

  it("renders with the input budget left after attachment images are reserved", async () => {
    const prepared = await prepareWorkflowContext(input("requirement_analysis", {
      preview: true,
      maxInputTokens: 128_000,
    }));

    expect(mocks.buildRequirementAnalysisPromptDraft).toHaveBeenCalledWith(expect.objectContaining({
      maxInputTokens: 32_000,
    }));
    expect(prepared.maxInputTokens).toBe(32_000);
  });

  it("returns review-required before generation when a reviewed work item disappears", async () => {
    mocks.resolveWorkflowContextWithoutLLM.mockRejectedValue(
      new ReviewedContextSourceUnavailableError("WI:404"),
    );

    await expect(prepareWorkflowContext(input("requirement_analysis", {
      reviewedSourceIds: ["WI:404"],
    }))).rejects.toMatchObject({ code: "CONTEXT_REVIEW_REQUIRED", missingSourceIds: ["WI:404"] });
  });

  it("returns review-required when a reviewed attachment is no longer ready", async () => {
    mocks.loadSelectedStoryAttachmentWorkflowContext.mockRejectedValue(new StoryAttachmentNotReadyError());

    await expect(prepareWorkflowContext(input("test_case_generation", {
      mode: "manual",
      attachmentIds: ["missing-attachment"],
      reviewedSourceIds: ["SA:missing-attachment"],
    }))).rejects.toMatchObject({
      code: "CONTEXT_REVIEW_REQUIRED",
      missingSourceIds: ["SA:missing-attachment"],
    });
  });

  it("rejects an oversized reviewed work item before generation", async () => {
    mocks.loadSelectedStoryAttachmentWorkflowContext.mockResolvedValueOnce({
      promptAttachments: [], citationAttachments: [], images: [], imageTokenReserve: 0,
      effectivePromptInputTokens: 4_000, warnings: [],
    });
    mocks.resolveWorkflowContextWithoutLLM.mockResolvedValue({
      relatedWorkItems: [],
      selectedContext: [{ workItemId: "200" }],
      contextUsed: [{
        workItemId: "200", title: "Oversized story", workItemType: "User Story",
        relevanceScore: 0.9, source: "explicit",
      }],
      retrievalTopK: 6,
    });
    mocks.buildRequirementAnalysisPromptDraft.mockReturnValue({
      ...draft({}),
      userPrompt: "x".repeat(40_000),
    });

    await expect(prepareWorkflowContext(input("requirement_analysis", {
      reviewedSourceIds: ["WI:200"],
      maxInputTokens: 4_000,
    }))).rejects.toMatchObject({ code: "CONTEXT_REVIEW_REQUIRED" });
  });
});
