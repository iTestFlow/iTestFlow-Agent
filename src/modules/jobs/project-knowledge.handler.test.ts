import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveUserLlmConfig: vi.fn(),
  createLLMProvider: vi.fn(),
  preview: vi.fn(),
  sqlGet: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  completeJobBatch: vi.fn(),
  loadCompletedJobBatch: vi.fn(),
}));

vi.mock("@/modules/credentials/credential.service", () => ({ resolveUserLlmConfig: mocks.resolveUserLlmConfig }));
vi.mock("@/modules/llm/llm-provider.factory", () => ({ createLLMProvider: mocks.createLLMProvider }));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  previewGeneratedProjectKnowledgeBase: mocks.preview,
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
    mocks.completeJobBatch.mockResolvedValue(true);
  });

  it("requires the initiating user and a project inside the workspace", async () => {
    await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation: "build" }, { createdByUserId: null }), context()))
      .rejects.toThrow("initiating user and workspace");
    mocks.sqlGet.mockResolvedValue(null);
    await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation: "build" }), context()))
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
    expect(mocks.loadCompletedJobBatch).toHaveBeenCalledWith("job-1", "extraction:1", "worker-1");
    expect(mocks.completeJobBatch).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", batchKey: "extraction:1", workerId: "worker-1" }));
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

  it("aborts the build when a batch-cache save is fenced out by lost job ownership", async () => {
    mocks.completeJobBatch.mockResolvedValue(false);
    mocks.preview.mockImplementation(async (input: { batchCache: { save: (index: number, value: Record<string, unknown>) => Promise<void> } }) => {
      await input.batchCache.save(1, { validatedOutput: {} });
      throw new Error("unreachable: the fenced save must throw first");
    });
    await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation: "build" }), context()))
      .rejects.toThrow("The worker no longer owns this job.");
  });

  it("rejects retired non-build operations at payload validation", async () => {
    for (const operation of ["manual_finalize", "apply_decisions", "publish"]) {
      await expect(runProjectKnowledgeJob(job({ projectId: "project-1", operation, draftId: "draft-1" }), context()))
        .rejects.toThrow();
    }
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.resolveUserLlmConfig).not.toHaveBeenCalled();
  });
});
