import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveUserLlmConfig: vi.fn(),
  createLLMProvider: vi.fn(),
  applyDecisions: vi.fn(),
  publishDraft: vi.fn(),
  preview: vi.fn(),
  manualFinalize: vi.fn(),
  sqlGet: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  completeJobBatch: vi.fn(),
  loadCompletedJobBatch: vi.fn(),
}));

vi.mock("@/modules/credentials/credential.service", () => ({ resolveUserLlmConfig: mocks.resolveUserLlmConfig }));
vi.mock("@/modules/llm/llm-provider.factory", () => ({ createLLMProvider: mocks.createLLMProvider }));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({
  applyProjectKnowledgeConflictDecisions: mocks.applyDecisions,
  publishProjectKnowledgeDraft: mocks.publishDraft,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  previewGeneratedProjectKnowledgeBase: mocks.preview,
  saveManualProjectKnowledgeBaseFromBatches: mocks.manualFinalize,
}));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ sqlGet: mocks.sqlGet }));
vi.mock("@/modules/workspace/workspace-settings.service", () => ({ getWorkspaceSettings: mocks.getWorkspaceSettings }));
vi.mock("./job-queue.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-queue.service")>();
  return { ...actual, completeJobBatch: mocks.completeJobBatch, loadCompletedJobBatch: mocks.loadCompletedJobBatch };
});

import { fakeLlmProvider } from "@/test/factories";
import type { Job } from "./job-queue.service";
import { PROJECT_KNOWLEDGE_JOB, runProjectKnowledgeJob } from "./project-knowledge.handler";

function job(payload: Record<string, unknown>, overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    jobType: PROJECT_KNOWLEDGE_JOB,
    payload,
    dedupeKey: "project_knowledge:project-1",
    status: "running",
    priority: 100,
    attempts: 1,
    maxAttempts: 3,
    lockedBy: "worker-1",
    lockedAt: "2026-07-15T00:00:00.000Z",
    runAfter: "2026-07-15T00:00:00.000Z",
    errorMessage: null,
    createdByUserId: "owner-1",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    progress: {},
    result: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function context() {
  return {
    workerId: "worker-1",
    signal: new AbortController().signal,
    updateProgress: vi.fn(async () => undefined),
  };
}

function draft(status: "blocked" | "ready_to_publish" | "superseded" | "published", pendingDrift = false) {
  return {
    id: "draft-1",
    persistedStatus: status,
    pendingDrift,
    blockers: status === "blocked" ? [{ type: "hard_conflict" }] : [],
    metrics: { omittedEntryCount: 2, omissionReasons: { quote_not_found: 2 } },
  };
}

describe("Project Knowledge v4 worker handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockResolvedValue({
      azure_project_id: "azure-project-1",
      azure_project_name: "Demo",
      azure_organization_url: "https://dev.azure.com/demo",
    });
    mocks.resolveUserLlmConfig.mockResolvedValue({
      provider: "openai", apiKey: "resolved-at-runtime", model: "gpt-test", baseUrl: undefined, maxInputTokens: 16000,
    });
    mocks.getWorkspaceSettings.mockResolvedValue({ maxOutputTokenCap: 8000, llmRetryAttempts: 2 });
    mocks.createLLMProvider.mockReturnValue(fakeLlmProvider());
    mocks.loadCompletedJobBatch.mockResolvedValue(null);
    mocks.completeJobBatch.mockResolvedValue(undefined);
  });

  it("requires the initiating user and a project inside the workspace", async () => {
    await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation: "build" }, { createdByUserId: null }), context()))
      .rejects.toThrow("initiating user and workspace");
    mocks.sqlGet.mockResolvedValue(null);
    await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation: "publish", draftId: "draft-1" }), context()))
      .rejects.toThrow("not found in its workspace");
  });

  it("resolves user credentials in the worker and reports build phases and summaries", async () => {
    const ctx = context();
    mocks.preview.mockImplementation(async (input: { onProgress: (value: Record<string, unknown>) => Promise<void>; batchCache: { load: (index: number) => Promise<unknown>; save: (index: number, value: Record<string, unknown>) => Promise<void> } }) => {
      await input.onProgress({ phase: "compiling_batches", completed: 1, total: 2, draftId: "draft-1" });
      await input.batchCache.load(1);
      await input.batchCache.save(1, { validatedOutput: {} });
      return {
        draftId: "draft-1",
        draftStatus: "blocked",
        blockers: [{ type: "hard_conflict" }],
        omittedEntryCount: 3,
        omissionReasons: { quote_not_found: 3 },
        warnings: ["3 entries omitted"],
      };
    });

    const result = await runProjectKnowledgeJob(job({ projectId: "project-1", operation: "build", mode: "incremental" }, {
      progress: { draftId: "draft-resume" },
    }), ctx);

    expect(mocks.resolveUserLlmConfig).toHaveBeenCalledWith("workspace-1", "owner-1");
    expect(mocks.createLLMProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "resolved-at-runtime" }));
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({
      actor: "owner-1",
      mode: "incremental",
      existingDraftId: "draft-resume",
      preserveDraftOnError: true,
      signal: ctx.signal,
    }));
    expect(mocks.loadCompletedJobBatch).toHaveBeenCalledWith("job-1", "extraction:1");
    expect(mocks.completeJobBatch).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", batchKey: "extraction:1" }));
    expect(ctx.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "compiling_batches", percent: 49 }));
    expect(result).toMatchObject({ outcome: "conflicts_required", conflictCount: 1, omittedEntryCount: 3 });
  });

  it("returns no_changes for an already-current build", async () => {
    mocks.preview.mockResolvedValue({
      draftId: "draft-1", draftStatus: "ready_to_publish", blockers: [], alreadyCurrent: true,
      omittedEntryCount: 0, omissionReasons: {}, warnings: [],
    });
    await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation: "build" }), context()))
      .resolves.toMatchObject({ outcome: "no_changes" });
  });

  it("finalizes manual batches and applies compact conflict decisions", async () => {
    mocks.manualFinalize.mockResolvedValue(draft("ready_to_publish"));
    await expect(runProjectKnowledgeJob(job({
      projectId: "project-1", operation: "manual_finalize", draftId: "draft-1", mode: "full",
    }), context())).resolves.toMatchObject({ outcome: "ready_to_publish", omittedEntryCount: 2 });
    expect(mocks.manualFinalize).toHaveBeenCalledWith(expect.objectContaining({ partialKnowledgeBases: [] }));

    mocks.applyDecisions.mockResolvedValue(draft("blocked"));
    const decisions = [{ conflictId: "c1", action: "keep", participantId: "p1" }];
    await expect(runProjectKnowledgeJob(job({
      projectId: "project-1", operation: "apply_decisions", draftId: "draft-1", draftVersion: "v1", decisions,
    }), context())).resolves.toMatchObject({ outcome: "conflicts_required", conflictCount: 1 });
    expect(mocks.applyDecisions).toHaveBeenCalledWith(expect.objectContaining({ decisions }));
  });

  it.each([
    ["manual_finalize", { draftVersion: "v1" }, "manual_finalize requires draftId"],
    ["apply_decisions", { draftId: "draft-1" }, "apply_decisions requires"],
    ["publish", {}, "publish requires draftId"],
  ])("validates required payload fields for %s", async (operation, extra, message) => {
    await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation, ...extra }), context()))
      .rejects.toThrow(message);
  });

  it("returns outdated without merging when another revision won", async () => {
    mocks.publishDraft.mockResolvedValue(draft("superseded"));
    const result = await runProjectKnowledgeJob(job({ projectId: "project-1", operation: "publish", draftId: "draft-1" }), context());
    expect(result).toMatchObject({ outcome: "outdated", draftStatus: "superseded" });
    expect(mocks.resolveUserLlmConfig).not.toHaveBeenCalled();
  });

  it("reports stale freshness after committing the exact reviewed draft", async () => {
    mocks.publishDraft.mockResolvedValue(draft("published", true));
    const result = await runProjectKnowledgeJob(job({ projectId: "project-1", operation: "publish", draftId: "draft-1" }), context());
    expect(result).toEqual({
      outcome: "published",
      draftId: "draft-1",
      draftStatus: "published",
      freshness: "stale",
      message: "Newer source updates will be included in the next build.",
    });
    expect(mocks.resolveUserLlmConfig).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
