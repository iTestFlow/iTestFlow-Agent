import { beforeEach, describe, expect, it, vi } from "vitest";

const registerJobHandler = vi.fn();
const runPlaywrightExecutionJob = vi.fn();

vi.mock("./job-handlers", () => ({ registerJobHandler }));
vi.mock("./workspace-sync.handler", () => ({ WORKSPACE_CONTEXT_SYNC: "workspace_context_sync", runWorkspaceContextSync: vi.fn() }));
vi.mock("./project-knowledge.handler", () => ({ PROJECT_KNOWLEDGE_JOB: "project_knowledge", runProjectKnowledgeJob: vi.fn() }));
vi.mock("./uploaded-document-ingest.handler", () => ({ runUploadedDocumentIngestJob: vi.fn() }));
vi.mock("./uploaded-document-jobs.service", () => ({ UPLOADED_DOCUMENT_INGEST: "uploaded_document_ingest" }));
vi.mock("@/modules/test-execution/playwright-execution-job", () => ({ runPlaywrightExecutionJob }));

describe("registerAllJobHandlers", () => {
  beforeEach(() => vi.resetModules());

  it("registers Playwright execution exactly once", async () => {
    const { registerAllJobHandlers } = await import("./register-handlers");
    registerAllJobHandlers();
    registerAllJobHandlers();
    expect(registerJobHandler).toHaveBeenCalledWith("playwright_mcp_execution", runPlaywrightExecutionJob);
    expect(registerJobHandler.mock.calls.filter(([type]) => type === "playwright_mcp_execution")).toHaveLength(1);
  });
});
