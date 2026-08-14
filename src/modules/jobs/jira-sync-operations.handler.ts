import "server-only";

import { runJiraProjectReconciliation } from "@/modules/integrations/jira-cloud/jira-sync-runtime.service";
import type { Job } from "./job-queue.service";

export async function runJiraSyncOperations(job: Job) {
  if (!job.workspaceId || !job.projectId) throw new Error("jira_sync_operations requires workspace and project scope.");
  const projectId = typeof job.payload.projectId === "string" ? job.payload.projectId.trim() : "";
  const operationId = typeof job.payload.operationId === "string" ? job.payload.operationId.trim() : "";
  if (!projectId || projectId !== job.projectId) throw new Error("jira_sync_operations payload does not match its project scope.");
  if (!operationId) throw new Error("jira_sync_operations requires an operationId.");
  return runJiraProjectReconciliation({
    workspaceId: job.workspaceId, projectId, operationId, actor: "system:worker", indexContext: false,
  });
}
