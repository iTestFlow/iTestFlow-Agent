import "server-only";

import { registerJobHandler } from "./job-handlers";
import { runWorkspaceContextSync, WORKSPACE_CONTEXT_SYNC } from "./workspace-sync.handler";
import { PROJECT_KNOWLEDGE_JOB, runProjectKnowledgeJob } from "./project-knowledge.handler";
import { runUploadedDocumentIngestJob } from "./uploaded-document-ingest.handler";
import { UPLOADED_DOCUMENT_INGEST } from "./uploaded-document-jobs.service";
import { runPlaywrightExecutionJob } from "@/modules/test-execution/playwright-execution-job";

let registered = false;

/** Registers all job handlers exactly once. Called by the worker at startup. */
export function registerAllJobHandlers(): void {
  if (registered) return;
  registerJobHandler(WORKSPACE_CONTEXT_SYNC, runWorkspaceContextSync);
  registerJobHandler(PROJECT_KNOWLEDGE_JOB, runProjectKnowledgeJob);
  registerJobHandler(UPLOADED_DOCUMENT_INGEST, runUploadedDocumentIngestJob);
  registerJobHandler("playwright_mcp_execution", runPlaywrightExecutionJob);
  registered = true;
}
