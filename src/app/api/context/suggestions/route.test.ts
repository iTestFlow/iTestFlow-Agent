import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  resolveRetrievalTopK: vi.fn(),
  retrieveStoredProjectContext: vi.fn(),
  suggestContextStories: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
    getUserLLMProvider: mocks.getUserLLMProvider,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/retrieval-config", () => ({
  resolveRetrievalTopK: mocks.resolveRetrievalTopK,
}));
vi.mock("@/modules/rag/project-context-store.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/rag/project-context-store.service")>();
  return { ...actual, retrieveStoredProjectContext: mocks.retrieveStoredProjectContext };
});
vi.mock("@/modules/context-selection/context-selection.service", () => ({
  suggestContextStories: mocks.suggestContextStories,
}));

import { fakeAzureAdapter, fakeLlmProvider, jsonRequest, projectScope, requirement } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const targetRequirement = requirement();
const requestBody = {
  scope: { ...trustedScope, workspaceId: "workspace-1" },
  targetWorkItemId: targetRequirement.id,
};

const targetWorkItem = {
  sourceType: "azure_work_item" as const,
  workItemId: targetRequirement.id,
  workItemType: "User Story",
  state: "Active",
  title: "The target itself",
  content: "Target context must not become a suggestion candidate.",
  relevanceScore: 1,
  metadata: { chunkIndex: 0 },
};

const workItemCandidate = {
  sourceType: "azure_work_item" as const,
  workItemId: "202",
  workItemType: "Feature",
  state: "Active",
  title: "Checkout orchestration",
  content: "Payment confirmation depends on checkout orchestration.",
  relevanceScore: 0.88,
  metadata: { chunkIndex: 0 },
};

const documentCandidate = {
  sourceType: "uploaded_document" as const,
  sourceId: "DOC:doc-security",
  documentId: "doc-security",
  documentVersionId: "docver-security-2",
  documentName: "Checkout security policy.pdf",
  title: "Checkout security policy.pdf",
  content: "Section 4 requires a confirmation audit record for every accepted payment.",
  relevanceScore: 0.83,
  metadata: { section: "page-4", pageNumber: 4, chunkIndex: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkflowContext.mockResolvedValue({ userId: "member-1", workspace: { id: "workspace-1" } });
  mocks.resolveProjectScope.mockResolvedValue(trustedScope);
  mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
    fetchWorkItemById: vi.fn(async () => targetRequirement),
  }));
  mocks.getUserLLMProvider.mockResolvedValue(fakeLlmProvider());
  mocks.resolveRetrievalTopK.mockResolvedValue(5);
  mocks.retrieveStoredProjectContext.mockResolvedValue([]);
  mocks.suggestContextStories.mockResolvedValue({
    validatedOutput: { suggestedItems: [], suggestedDocuments: [] },
    rawOutput: "{\"suggestedItems\":[],\"suggestedDocuments\":[]}",
    provider: "openai",
    model: "test-model",
  });
});

describe("POST /api/context/suggestions", () => {
  it("defaults to both source kinds and returns re-hydrated document suggestions with citations", async () => {
    mocks.retrieveStoredProjectContext.mockResolvedValue([
      targetWorkItem,
      workItemCandidate,
      documentCandidate,
      { ...documentCandidate, content: "A second chunk must be deduplicated.", metadata: { section: "page-5", pageNumber: 5, chunkIndex: 1 } },
    ]);
    mocks.suggestContextStories.mockResolvedValue({
      validatedOutput: {
        suggestedItems: [{
          workItemId: "202",
          title: "Checkout orchestration",
          workItemType: "Feature",
          relevanceScore: 0.88,
          reason: "It describes the flow that produces the confirmation.",
        }],
        suggestedDocuments: [
          {
            documentId: "doc-security",
            documentVersionId: "docver-security-2",
            // A provider-controlled display name is deliberately replaced by the
            // immutable candidate's name in the public response.
            documentName: "Made-up display name",
            relevanceScore: 0.83,
            reason: "It defines the audit record required for accepted payments.",
          },
          {
            documentId: "hallucinated-document",
            documentVersionId: "hallucinated-version",
            documentName: "Not retrieved.pdf",
            relevanceScore: 0.99,
            reason: "This must be discarded.",
          },
        ],
      },
      rawOutput: "raw-provider-output",
      provider: "openai",
      model: "test-model",
    });

    const response = await POST(jsonRequest("/api/context/suggestions", requestBody));

    expect(response.status).toBe(200);
    expect(mocks.retrieveStoredProjectContext).toHaveBeenCalledWith({
      scope: trustedScope,
      query: expect.any(String),
      topK: 40,
      sourceKinds: ["azure_work_item", "uploaded_document"],
    });
    expect(mocks.suggestContextStories).toHaveBeenCalledWith(expect.objectContaining({
      scope: trustedScope,
      targetRequirement,
      maxContextItems: 5,
      retrievedContext: [workItemCandidate, documentCandidate],
    }));

    const body = await response.json();
    expect(body).toMatchObject({
      targetWorkItemId: "101",
      sourceKinds: ["azure_work_item", "uploaded_document"],
      suggestions: [expect.objectContaining({ workItemId: "202" })],
      documentSuggestions: [{
        sourceType: "uploaded_document",
        sourceId: "DOC:doc-security",
        documentId: "doc-security",
        documentVersionId: "docver-security-2",
        documentName: "Checkout security policy.pdf",
        citation: {
          sourceType: "uploaded_document",
          sourceId: "DOC:doc-security",
          section: "page-4",
          pageNumber: 4,
        },
      }],
      candidates: expect.arrayContaining([
        expect.objectContaining({
          sourceType: "azure_work_item",
          sourceId: "WI:202",
          citation: expect.objectContaining({ sourceId: "WI:202" }),
        }),
        expect.objectContaining({
          sourceType: "uploaded_document",
          sourceId: "DOC:doc-security",
          documentId: "doc-security",
          citation: expect.objectContaining({ pageNumber: 4, section: "page-4" }),
        }),
      ]),
    });
    expect(body.candidates).toHaveLength(2);
    expect(body.documentSuggestions).toHaveLength(1);
  });

  it("honors an explicit document-only source filter", async () => {
    mocks.retrieveStoredProjectContext.mockResolvedValue([documentCandidate]);
    mocks.suggestContextStories.mockResolvedValue({
      validatedOutput: {
        suggestedItems: [],
        suggestedDocuments: [{
          documentId: "doc-security",
          documentVersionId: "docver-security-2",
          documentName: documentCandidate.documentName,
          relevanceScore: 0.83,
          reason: "It states the confirmation audit requirement.",
        }],
      },
      rawOutput: "raw-provider-output",
      provider: "openai",
      model: "test-model",
    });

    const response = await POST(jsonRequest("/api/context/suggestions", {
      ...requestBody,
      sourceKinds: ["uploaded_document"],
    }));

    expect(response.status).toBe(200);
    expect(mocks.retrieveStoredProjectContext).toHaveBeenCalledWith(expect.objectContaining({
      sourceKinds: ["uploaded_document"],
    }));
    expect((await response.json()).documentSuggestions).toHaveLength(1);
  });

  it("rejects an unsupported source kind before resolving the user scope", async () => {
    const response = await POST(jsonRequest("/api/context/suggestions", {
      ...requestBody,
      sourceKinds: ["remote_connector"],
    }));

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });
});
