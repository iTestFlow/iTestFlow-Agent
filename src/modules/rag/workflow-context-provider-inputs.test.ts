import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkflowContext: vi.fn(),
  resolveWorkflowContextWithoutLLM: vi.fn(),
  resolveRetrievalTopK: vi.fn(),
  loadProjectKnowledgeContext: vi.fn(),
  rankProjectKnowledgeForWorkItem: vi.fn(),
  loadSelectedStoryAttachmentWorkflowContext: vi.fn(),
}));

vi.mock("./auto-context-resolver.service", () => ({
  resolveWorkflowContext: mocks.resolveWorkflowContext,
  resolveWorkflowContextWithoutLLM: mocks.resolveWorkflowContextWithoutLLM,
}));
vi.mock("./retrieval-config", () => ({ resolveRetrievalTopK: mocks.resolveRetrievalTopK }));
vi.mock("./project-knowledge.service", () => ({
  loadProjectKnowledgeContext: mocks.loadProjectKnowledgeContext,
}));
vi.mock("./knowledge-relevance.service", () => ({
  rankProjectKnowledgeForWorkItem: mocks.rankProjectKnowledgeForWorkItem,
}));
vi.mock("@/modules/story-attachments/story-attachment-workflow-context", () => ({
  loadSelectedStoryAttachmentWorkflowContext: mocks.loadSelectedStoryAttachmentWorkflowContext,
}));

import { fakeAzureAdapter, fakeLlmProvider, projectScope, requirement, testCase } from "@/test/factories";
import { runRequirementAnalysis, buildRequirementAnalysisPromptDraft } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { generateTestCases, buildTestCaseGenerationPromptDraft } from "@/modules/test-case-design/application/test-case-generation.service";
import { reviewExistingLinkedTestCases, buildExistingTestCaseReviewPromptDraft } from "@/modules/existing-test-case-review/application/existing-test-case-review.service";
import { ProjectKnowledgeBaseSchema } from "./project-knowledge.schema";
import { prepareWorkflowContext, type WorkflowContextWorkflow } from "./workflow-context-preparation.service";

const scope = projectScope();
const targetRequirement = requirement({ id: "101", title: "Target story" });
const removedContent = "SECRET_REMOVED_STORY_CONTENT";
const removedRule = "SECRET_REMOVED_KNOWLEDGE_RULE";
const removedAttachment = "SECRET_REMOVED_ATTACHMENT_TEXT";

function contextItem(workItemId: string, content: string) {
  return {
    sourceType: "azure_work_item" as const,
    workItemId,
    workItemType: "User Story",
    title: `Story ${workItemId}`,
    state: "Active",
    content,
    relevanceScore: 0.9,
    metadata: { chunkIndex: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const removed = contextItem("200", removedContent);
  const retained = contextItem("300", "RETAINED_STORY_CONTENT");
  mocks.resolveRetrievalTopK.mockResolvedValue(6);
  mocks.resolveWorkflowContextWithoutLLM.mockResolvedValue({
    relatedWorkItems: [removed, retained],
    selectedContext: [removed, retained],
    contextUsed: [removed, retained].map((item) => ({
      workItemId: item.workItemId,
      workItemType: item.workItemType,
      title: item.title,
      source: "linked_requirement",
      relevanceScore: item.relevanceScore,
    })),
    retrievalTopK: 6,
  });
  mocks.loadProjectKnowledgeContext.mockResolvedValue({
    knowledgeBase: ProjectKnowledgeBaseSchema.parse({
      modules: [],
      businessRules: [{
        id: "removed-rule",
        rule: removedRule,
        sourceField: "description",
        sourceWorkItemIds: ["200", "300"],
        evidence: removedRule,
      }],
      stateTransitions: [],
      glossary: [],
      crossDependencies: [],
      chatInsights: [],
    }),
    promptNotice: null,
  });
  mocks.rankProjectKnowledgeForWorkItem.mockResolvedValue(null);
  mocks.loadSelectedStoryAttachmentWorkflowContext.mockImplementation(async ({ attachmentIds }: { attachmentIds: string[] }) => ({
    promptAttachments: attachmentIds.map((id) => ({
      id,
      fileName: `${id}.png`,
      text: id === "removed" ? removedAttachment : "RETAINED_ATTACHMENT_TEXT",
      visualCount: 1,
    })),
    citationAttachments: attachmentIds.map((id) => ({ id, fileName: `${id}.png`, visualCount: 1 })),
    images: attachmentIds.map((id) => ({ mediaType: "image/png", data: `${id}-image-bytes` })),
    imageTokenReserve: 256,
    effectivePromptInputTokens: 32_000,
    warnings: [],
  }));
});

async function prepare(workflow: WorkflowContextWorkflow, mode: "auto" | "manual") {
  return prepareWorkflowContext({
    workflow,
    mode,
    scope,
    actor: "tester@example.com",
    adapter: fakeAzureAdapter({ fetchLinkedTestCases: vi.fn(async () => [testCase()]) }),
    provider: fakeLlmProvider(),
    workspaceId: "workspace-1",
    workspaceProviderId: "azure-devops",
    targetRequirement,
    reviewedSourceIds: [
      "WI:200",
      "WI:300",
      "KB:business_rule:removed-rule",
      ...(workflow === "existing_test_case_review" ? [] : ["SA:removed", "SA:retained"]),
    ],
    excludedSourceIds: ["WI:200", "SA:removed"],
    attachmentIds: ["removed", "retained"],
    maxInputTokens: 32_000,
  });
}

describe("reviewed context provider inputs", () => {
  it.each<WorkflowContextWorkflow>([
    "requirement_analysis",
    "test_case_generation",
    "existing_test_case_review",
  ])("keeps excluded content out of the %s manual prompt", async (workflow) => {
    const prepared = await prepare(workflow, "manual");
    expect(prepared.promptDraft.prompt).not.toContain(removedContent);
    expect(prepared.promptDraft.prompt).not.toContain(removedRule);
    expect(prepared.promptDraft.prompt).not.toContain(removedAttachment);
    expect(prepared.promptDraft.prompt).toContain("RETAINED_STORY_CONTENT");
    expect(mocks.resolveWorkflowContext).not.toHaveBeenCalled();
  });

  it.each<WorkflowContextWorkflow>([
    "requirement_analysis",
    "test_case_generation",
    "existing_test_case_review",
  ])("keeps excluded content out of the %s automatic provider request", async (workflow) => {
    const prepared = await prepare(workflow, "auto");
    const provider = fakeLlmProvider();
    const stop = new Error("Stop after capturing provider input");
    vi.mocked(provider.generateStructuredOutput).mockRejectedValue(stop);
    const shared = {
      scope,
      actor: "tester@example.com",
      provider,
      targetRequirement,
      relatedWorkItems: prepared.relatedWorkItems,
      selectedContext: prepared.selectedContext,
      projectKnowledgeBase: prepared.projectKnowledgeBase,
      maxInputTokens: prepared.maxInputTokens,
      relatedWorkItemsFloor: prepared.retrievalTopK,
      rankedKnowledgeKeys: prepared.rankedKnowledgeKeys,
      projectKnowledgeNotice: prepared.projectKnowledgeNotice,
    };

    if (workflow === "requirement_analysis") {
      await expect(runRequirementAnalysis({
        ...shared,
        storyAttachments: prepared.storyAttachmentContext?.promptAttachments,
        attachmentImages: prepared.storyAttachmentContext?.images,
        preparedPromptDraft: prepared.promptDraft as ReturnType<typeof buildRequirementAnalysisPromptDraft>,
      })).rejects.toBe(stop);
    } else if (workflow === "test_case_generation") {
      await expect(generateTestCases({
        ...shared,
        storyAttachments: prepared.storyAttachmentContext?.promptAttachments,
        attachmentImages: prepared.storyAttachmentContext?.images,
        preparedPromptDraft: prepared.promptDraft as ReturnType<typeof buildTestCaseGenerationPromptDraft>,
      })).rejects.toBe(stop);
    } else {
      await expect(reviewExistingLinkedTestCases({
        ...shared,
        linkedTestCases: prepared.linkedTestCases,
        preparedPromptDraft: prepared.promptDraft as ReturnType<typeof buildExistingTestCaseReviewPromptDraft>,
      })).rejects.toBe(stop);
    }

    expect(provider.generateStructuredOutput).toHaveBeenCalledOnce();
    const request = vi.mocked(provider.generateStructuredOutput).mock.calls[0]![0];
    expect(request.user).not.toContain(removedContent);
    expect(request.user).not.toContain(removedRule);
    expect(request.user).not.toContain(removedAttachment);
    expect(request.user).toContain("RETAINED_STORY_CONTENT");
    expect(request.images ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: "removed-image-bytes" }),
    ]));
    if (workflow !== "existing_test_case_review") {
      expect(request.images).toEqual([expect.objectContaining({ data: "retained-image-bytes" })]);
    }
  });
});
