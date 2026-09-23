import { beforeEach, describe, expect, it, vi } from "vitest";

// Retrieval is a module-level import; only the store lookup is faked — the pure
// mapping helpers stay real so merge/dedupe assertions exercise actual shapes.
vi.mock("./project-context-store.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-context-store.service")>();
  return { ...actual, retrieveStoredProjectContext: vi.fn() };
});

vi.mock("@/modules/context-selection/context-selection.service", () => ({
  suggestContextStories: vi.fn(),
}));

import { suggestContextStories } from "@/modules/context-selection/context-selection.service";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import { IntegrationError } from "@/modules/integrations/core/integration-error";
import { fakeAzureAdapter, fakeLlmProvider, projectScope, requirement } from "@/test/factories";
import {
  requirementToRetrievalQuery,
  retrieveStoredProjectContext,
  workItemToLlmContextSource,
  type LlmWorkItemContextSource,
} from "./project-context-store.service";
import {
  isRequirementContextWorkItem,
  REQUIREMENT_CONTEXT_WORK_ITEM_TYPES,
  ReviewedContextSourceUnavailableError,
  resolveWorkflowContext,
  resolveWorkflowContextWithoutLLM,
} from "./auto-context-resolver.service";

const retrieveStoredProjectContextMock = vi.mocked(retrieveStoredProjectContext);
const suggestContextStoriesMock = vi.mocked(suggestContextStories);

function storedContext(overrides: Partial<LlmWorkItemContextSource> = {}): LlmWorkItemContextSource {
  return {
    sourceType: "azure_work_item",
    workItemId: "400",
    workItemType: "User Story",
    state: "Active",
    title: "Stored story",
    content: "Stored chunk content",
    relevanceScore: 0.5,
    metadata: { chunkIndex: 0 },
    ...overrides,
  };
}

function suggestionResult(workItemIds: string[]) {
  return {
    validatedOutput: {
      suggestedItems: workItemIds.map((workItemId) => ({
        workItemId,
        title: `Item ${workItemId}`,
        workItemType: "User Story",
        relevanceScore: 0.9,
        reason: "Related flow",
      })),
    },
  } as Awaited<ReturnType<typeof suggestContextStories>>;
}

const linkedFeature = requirement({ id: "300", workItemType: "Feature", title: "Linked feature" });

function adapterFns() {
  return {
    fetchLinkedRequirementWorkItems: vi.fn<AzureDevOpsAdapter["fetchLinkedRequirementWorkItems"]>(
      async () => [linkedFeature],
    ),
    fetchWorkItemById: vi.fn<AzureDevOpsAdapter["fetchWorkItemById"]>(async () => {
      throw new Error("Unexpected fetchWorkItemById call");
    }),
  };
}

beforeEach(() => {
  retrieveStoredProjectContextMock.mockReset().mockResolvedValue([]);
  suggestContextStoriesMock.mockReset();
});

describe("resolveWorkflowContext (explicit selection path)", () => {
  it("pins linked requirements ahead of the explicit selection, deduping by workItemId, without invoking the LLM", async () => {
    const scope = projectScope();
    const fns = adapterFns();
    // Linked results include the target itself and a non-requirement type; both are dropped.
    fns.fetchLinkedRequirementWorkItems.mockResolvedValue([
      requirement({ id: "101" }),
      requirement({ id: "999", workItemType: "Task", title: "A task" }),
      linkedFeature,
    ]);
    // Explicit ID 300 is also linked: the pinned copy (relevanceScore 1) must win the dedupe.
    retrieveStoredProjectContextMock.mockResolvedValue([
      storedContext({ workItemId: "300", relevanceScore: 0.42, content: "stale stored copy" }),
      storedContext({ workItemId: "400" }),
    ]);

    const resolution = await resolveWorkflowContext({
      scope,
      actor: "tester@example.com",
      adapter: fakeAzureAdapter(fns),
      provider: fakeLlmProvider(),
      targetRequirement: requirement(),
      selectedContextIds: ["300", "400"],
      retrievalTopK: 4,
      workflowType: "test_case_generation",
    });

    expect(resolution.selectedContext.map((item) => item.workItemId)).toEqual(["300", "400"]);
    expect(resolution.selectedContext[0]).toEqual(workItemToLlmContextSource(linkedFeature, 1));
    expect(resolution.relatedWorkItems).toEqual([workItemToLlmContextSource(linkedFeature, 1)]);
    expect(resolution.contextUsed).toEqual([
      expect.objectContaining({ workItemId: "300", source: "linked_requirement", relevanceScore: 1 }),
      expect.objectContaining({ workItemId: "400", source: "explicit" }),
    ]);
    expect(resolution.retrievalTopK).toBe(4);
    expect(suggestContextStoriesMock).not.toHaveBeenCalled();
    expect(fns.fetchLinkedRequirementWorkItems).toHaveBeenCalledWith({
      projectId: scope.azureProjectId,
      workItemId: "101",
      workItemTypes: REQUIREMENT_CONTEXT_WORK_ITEM_TYPES,
    });
    // Explicit retrieval widens topK to 3x the selected IDs so pinned IDs are not crowded out.
    expect(retrieveStoredProjectContextMock).toHaveBeenCalledWith({
      scope,
      query: "300 400",
      workItemIds: ["300", "400"],
      topK: 6,
      sourceKinds: ["azure_work_item"],
    });
  });

  it("fetches explicit IDs missing from the store through the adapter and merges them after stored hits", async () => {
    const fns = adapterFns();
    fns.fetchLinkedRequirementWorkItems.mockResolvedValue([]);
    const fetchedPbi = requirement({ id: "500", workItemType: "Product Backlog Item", title: "Fetched PBI" });
    fns.fetchWorkItemById.mockResolvedValue(fetchedPbi);
    retrieveStoredProjectContextMock.mockResolvedValue([storedContext({ workItemId: "400" })]);

    const resolution = await resolveWorkflowContext({
      scope: projectScope(),
      actor: "tester@example.com",
      adapter: fakeAzureAdapter(fns),
      provider: fakeLlmProvider(),
      targetRequirement: requirement(),
      selectedContextIds: ["400", "500"],
      retrievalTopK: 8,
      workflowType: "requirement_analysis",
    });

    expect(fns.fetchWorkItemById).toHaveBeenCalledExactlyOnceWith({
      projectId: "azure-project-1",
      workItemId: "500",
    });
    expect(resolution.selectedContext).toEqual([
      storedContext({ workItemId: "400" }),
      workItemToLlmContextSource(fetchedPbi),
    ]);
    expect(resolution.contextUsed.map((item) => item.source)).toEqual(["explicit", "explicit"]);
  });
});

describe("resolveWorkflowContextWithoutLLM", () => {
  it("resolves deterministically from linked + stored context and never calls suggestContextStories", async () => {
    const target = requirement();
    const fns = adapterFns();
    // Stored hits include the target itself; it must be excluded from candidates.
    retrieveStoredProjectContextMock.mockResolvedValue([
      storedContext({ workItemId: target.id, title: "The target itself" }),
      storedContext({ workItemId: "400" }),
      storedContext({ workItemId: "500", relevanceScore: 0.3 }),
    ]);

    const resolution = await resolveWorkflowContextWithoutLLM({
      scope: projectScope(),
      adapter: fakeAzureAdapter(fns),
      targetRequirement: target,
      retrievalTopK: 8,
    });

    expect(suggestContextStoriesMock).not.toHaveBeenCalled();
    expect(resolution.selectedContext.map((item) => item.workItemId)).toEqual(["300", "400", "500"]);
    expect(resolution.contextUsed).toEqual([
      expect.objectContaining({ workItemId: "300", source: "linked_requirement" }),
      expect.objectContaining({ workItemId: "400", source: "stored_project_context" }),
      expect.objectContaining({ workItemId: "500", source: "stored_project_context" }),
    ]);
    expect(retrieveStoredProjectContextMock).toHaveBeenCalledWith({
      scope: projectScope(),
      query: requirementToRetrievalQuery(target),
      topK: 8,
      sourceKinds: ["azure_work_item"],
    });
  });

  // clampTopK is private; extreme retrieval settings drive it through the public API.
  it.each([
    { retrievalTopK: Number.NaN, expected: 8 },
    { retrievalTopK: undefined, expected: 8 },
    { retrievalTopK: 1000, expected: 25 },
    { retrievalTopK: -5, expected: 1 },
    { retrievalTopK: 7.4, expected: 7 },
  ])("clamps retrievalTopK $retrievalTopK to $expected", async ({ retrievalTopK, expected }) => {
    const fns = adapterFns();
    fns.fetchLinkedRequirementWorkItems.mockResolvedValue([]);

    const resolution = await resolveWorkflowContextWithoutLLM({
      scope: projectScope(),
      adapter: fakeAzureAdapter(fns),
      targetRequirement: requirement(),
      retrievalTopK: retrievalTopK as number,
    });

    expect(resolution.retrievalTopK).toBe(expected);
    expect(retrieveStoredProjectContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ topK: expected, sourceKinds: ["azure_work_item"] }),
    );
  });
});

describe("reviewed workflow context", () => {
  it("honors an explicitly empty review without loading linked or replacement context", async () => {
    const fns = adapterFns();

    const resolution = await resolveWorkflowContextWithoutLLM({
      scope: projectScope(),
      adapter: fakeAzureAdapter(fns),
      targetRequirement: requirement(),
      reviewedSourceIds: [],
      excludedSourceIds: [],
      retrievalTopK: 8,
    });

    expect(resolution).toEqual({
      selectedContext: [],
      relatedWorkItems: [],
      contextUsed: [],
      retrievalTopK: 8,
    });
    expect(fns.fetchLinkedRequirementWorkItems).not.toHaveBeenCalled();
    expect(retrieveStoredProjectContextMock).not.toHaveBeenCalled();
    expect(suggestContextStoriesMock).not.toHaveBeenCalled();
  });

  it("loads only reviewed work items and never adds linked or retrieved replacements", async () => {
    const fns = adapterFns();
    fns.fetchWorkItemById.mockResolvedValue(requirement({ id: "400", title: "Reviewed story" }));
    retrieveStoredProjectContextMock.mockResolvedValue([
      storedContext({ workItemId: "400", title: "Reviewed story" }),
      storedContext({ workItemId: "500", title: "Unreviewed replacement" }),
    ]);

    const resolution = await resolveWorkflowContext({
      scope: projectScope(),
      actor: "tester@example.com",
      adapter: fakeAzureAdapter(fns),
      provider: fakeLlmProvider(),
      targetRequirement: requirement(),
      reviewedSourceIds: ["WI:400"],
      excludedSourceIds: [],
      retrievalTopK: 8,
      workflowType: "test_case_generation",
    });

    expect(resolution.selectedContext.map((item) => item.workItemId)).toEqual(["400"]);
    expect(resolution.relatedWorkItems).toEqual([]);
    expect(resolution.contextUsed).toEqual([
      expect.objectContaining({ workItemId: "400", source: "explicit" }),
    ]);
    expect(fns.fetchLinkedRequirementWorkItems).not.toHaveBeenCalled();
    expect(suggestContextStoriesMock).not.toHaveBeenCalled();
    expect(retrieveStoredProjectContextMock).not.toHaveBeenCalled();
    expect(fns.fetchWorkItemById).toHaveBeenCalledWith({
      projectId: "azure-project-1", workItemId: "400",
    });
  });

  it("honors exclusions before reviewed work-item loading", async () => {
    const fns = adapterFns();

    const resolution = await resolveWorkflowContextWithoutLLM({
      scope: projectScope(),
      adapter: fakeAzureAdapter(fns),
      targetRequirement: requirement(),
      reviewedSourceIds: ["WI:400"],
      excludedSourceIds: ["WI:400"],
      retrievalTopK: 8,
    });

    expect(resolution.selectedContext).toEqual([]);
    expect(retrieveStoredProjectContextMock).not.toHaveBeenCalled();
  });

  it.each(["integration_not_found", "integration_permission_denied"] as const)(
    "identifies a reviewed work item that disappeared despite a cached hit (%s)", async (code) => {
    retrieveStoredProjectContextMock.mockResolvedValue([storedContext({ workItemId: "404" })]);
    const adapter = fakeAzureAdapter({
      fetchWorkItemById: vi.fn(async () => {
        throw new IntegrationError({ code, statusCode: code === "integration_not_found" ? 404 : 403, message: "Unavailable work item" });
      }),
    });

    await expect(resolveWorkflowContextWithoutLLM({
      scope: projectScope(),
      adapter,
      targetRequirement: requirement(),
      reviewedSourceIds: ["WI:404"],
      retrievalTopK: 8,
    })).rejects.toMatchObject({
      name: ReviewedContextSourceUnavailableError.name,
      sourceId: "WI:404",
    });
    expect(retrieveStoredProjectContextMock).not.toHaveBeenCalled();
  });
});

describe("resolveWorkflowContext (LLM selection path)", () => {
  it("returns the documented empty shape on an empty corpus instead of calling the LLM", async () => {
    const fns = adapterFns();
    fns.fetchLinkedRequirementWorkItems.mockResolvedValue([]);
    const provider = fakeLlmProvider();

    const resolution = await resolveWorkflowContext({
      scope: projectScope(),
      actor: "tester@example.com",
      adapter: fakeAzureAdapter(fns),
      provider,
      targetRequirement: requirement(),
      retrievalTopK: 8,
      workflowType: "requirement_analysis",
    });

    expect(resolution).toEqual({
      selectedContext: [],
      relatedWorkItems: [],
      contextUsed: [],
      retrievalTopK: 8,
    });
    expect(suggestContextStoriesMock).not.toHaveBeenCalled();
    expect(provider.generateStructuredOutput).not.toHaveBeenCalled();
  });

  it("keeps LLM-selected candidates, pins linked requirements ahead, and labels sources accordingly", async () => {
    const scope = projectScope();
    const target = requirement();
    const provider = fakeLlmProvider();
    retrieveStoredProjectContextMock.mockResolvedValue([
      storedContext({ workItemId: "400" }),
      storedContext({ workItemId: "500" }),
      storedContext({ workItemId: "600" }),
    ]);
    // "700" is not a retrieval candidate: hallucinated IDs are discarded.
    suggestContextStoriesMock.mockResolvedValue(suggestionResult(["500", "700"]));

    const resolution = await resolveWorkflowContext({
      scope,
      actor: "tester@example.com",
      adapter: fakeAzureAdapter(adapterFns()),
      provider,
      targetRequirement: target,
      retrievalTopK: 8,
      workflowType: "test_case_generation",
    });

    expect(resolution.selectedContext.map((item) => item.workItemId)).toEqual(["300", "500"]);
    expect(resolution.contextUsed).toEqual([
      expect.objectContaining({ workItemId: "300", source: "linked_requirement" }),
      expect.objectContaining({ workItemId: "500", source: "llm_selected_context", reason: "Related flow" }),
    ]);
    expect(suggestContextStoriesMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scope,
        actor: "tester@example.com",
        provider,
        targetRequirement: target,
        maxContextItems: 8,
        action: "test_case_generation.auto_context_select",
      }),
    );
    // Candidate ordering handed to the LLM: linked requirements first, then stored hits.
    const { retrievedContext } = suggestContextStoriesMock.mock.calls[0][0];
    expect((retrievedContext as LlmWorkItemContextSource[]).map((item) => item.workItemId)).toEqual([
      "300",
      "400",
      "500",
      "600",
    ]);
  });

  it("falls back to deterministic top-K candidates when LLM selection fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    retrieveStoredProjectContextMock.mockResolvedValue([
      storedContext({ workItemId: "400" }),
      storedContext({ workItemId: "500" }),
    ]);
    suggestContextStoriesMock.mockRejectedValue(new Error("provider unavailable"));

    const resolution = await resolveWorkflowContext({
      scope: projectScope(),
      actor: "tester@example.com",
      adapter: fakeAzureAdapter(adapterFns()),
      provider: fakeLlmProvider(),
      targetRequirement: requirement(),
      retrievalTopK: 2,
      workflowType: "requirement_analysis",
    });

    expect(resolution.selectedContext.map((item) => item.workItemId)).toEqual(["300", "400"]);
    expect(resolution.contextUsed.map((item) => item.source)).toEqual([
      "linked_requirement",
      "stored_project_context",
    ]);
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("isRequirementContextWorkItem", () => {
  it("matches requirement context types case-insensitively with surrounding whitespace", () => {
    expect(isRequirementContextWorkItem({ workItemType: "  user story  " })).toBe(true);
    expect(isRequirementContextWorkItem({ workItemType: "PRODUCT BACKLOG ITEM" })).toBe(true);
    expect(isRequirementContextWorkItem({ workItemType: "Task" })).toBe(false);
    expect(isRequirementContextWorkItem({ workItemType: "Bug" })).toBe(false);
  });
});
