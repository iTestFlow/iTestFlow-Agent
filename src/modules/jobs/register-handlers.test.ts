import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ registerJobHandler: vi.fn() }));
vi.mock("./job-handlers", () => ({ registerJobHandler: mocks.registerJobHandler }));
vi.mock("./workspace-sync.handler", () => ({ WORKSPACE_CONTEXT_SYNC: "workspace_context_sync", runWorkspaceContextSync: vi.fn() }));
vi.mock("./project-knowledge.handler", () => ({ PROJECT_KNOWLEDGE_JOB: "project_knowledge", runProjectKnowledgeJob: vi.fn() }));
vi.mock("./uploaded-document-ingest.handler", () => ({ runUploadedDocumentIngestJob: vi.fn() }));
vi.mock("./uploaded-document-jobs.service", () => ({ UPLOADED_DOCUMENT_INGEST: "uploaded_document_ingest" }));
vi.mock("./jira-webhook-reconcile.handler", () => ({ runJiraWebhookReconcile: vi.fn() }));
vi.mock("./jira-sync-operations.handler", () => ({ runJiraSyncOperations: vi.fn() }));
vi.mock("@/modules/integrations/jira-cloud/jira-sync-runtime.service", () => ({ JIRA_SYNC_OPERATIONS: "jira_sync_operations" }));

import { registerAllJobHandlers } from "./register-handlers";

it("registers the durable Jira webhook reconciliation worker", () => {
  registerAllJobHandlers();
  expect(mocks.registerJobHandler).toHaveBeenCalledWith("jira_webhook_reconcile", expect.any(Function));
  expect(mocks.registerJobHandler).toHaveBeenCalledWith("jira_sync_operations", expect.any(Function));
});
