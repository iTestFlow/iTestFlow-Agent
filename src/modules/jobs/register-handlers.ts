import "server-only";

import { registerJobHandler } from "./job-handlers";
import { runWorkspaceContextSync, WORKSPACE_CONTEXT_SYNC } from "./workspace-sync.handler";
import { PROJECT_KNOWLEDGE_JOB, runProjectKnowledgeJob } from "./project-knowledge.handler";
import { runUploadedDocumentIngestJob } from "./uploaded-document-ingest.handler";
import { UPLOADED_DOCUMENT_INGEST } from "./uploaded-document-jobs.service";
import { runTestExecutionRunJob } from "./test-execution-run.handler";
import { TEST_EXECUTION_RUN } from "./test-execution-jobs.service";

let registered = false;

/** Registers all job handlers exactly once. Called by the worker at startup. */
export function registerAllJobHandlers(): void {
  if (registered) return;
  registerJobHandler(WORKSPACE_CONTEXT_SYNC, runWorkspaceContextSync);
  registerJobHandler(PROJECT_KNOWLEDGE_JOB, runProjectKnowledgeJob);
  registerJobHandler(UPLOADED_DOCUMENT_INGEST, runUploadedDocumentIngestJob);
  registerJobHandler(TEST_EXECUTION_RUN, runTestExecutionRunJob);
  registered = true;
}
