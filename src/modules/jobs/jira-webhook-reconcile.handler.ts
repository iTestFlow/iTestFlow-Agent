import "server-only";

import { retireJiraIssueMapping, runJiraProjectReconciliation } from "@/modules/integrations/jira-cloud/jira-sync-runtime.service";
import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import type { Job } from "./job-queue.service";

type EventRow = {
  id: string; workspace_id: string; project_id: string; status: "pending" | "processing" | "completed" | "failed";
  payload_json: string;
};

export async function runJiraWebhookReconcile(job: Job) {
  if (!job.workspaceId || !job.projectId) throw new Error("jira_webhook_reconcile requires workspace and project scope.");
  const eventId = typeof job.payload.eventId === "string" ? job.payload.eventId.trim() : "";
  if (!eventId) throw new Error("jira_webhook_reconcile requires an eventId.");
  const event = await sqlGet<EventRow>(
    `SELECT id, workspace_id, project_id, status, payload_json
     FROM jira_webhook_events
     WHERE id = @eventId AND workspace_id = @workspaceId AND project_id = @projectId
       AND status IN ('pending', 'processing')`,
    { eventId, workspaceId: job.workspaceId, projectId: job.projectId },
  );
  if (!event) throw new Error("The Jira webhook event is unavailable in this job scope.");
  await sqlRun(
    `UPDATE jira_webhook_events SET status = 'processing', updated_at = @now
     WHERE id = @eventId AND workspace_id = @workspaceId AND project_id = @projectId
       AND status IN ('pending', 'processing')`,
    { eventId, workspaceId: job.workspaceId, projectId: job.projectId, now: nowIso() },
  );
  try {
    const payload = parsePayload(event.payload_json);
    const result = payload.eventType === "jira:issue_deleted" && payload.issueKey
      ? await retireJiraIssueMapping({ workspaceId: job.workspaceId, projectId: job.projectId, issueKey: payload.issueKey, actor: "system:webhook" })
      : await runJiraProjectReconciliation({
        workspaceId: job.workspaceId, projectId: job.projectId, actor: "system:webhook",
        ...(payload.issueKey ? { issueKeys: [payload.issueKey] } : {}), indexContext: false,
      });
    const now = nowIso();
    if (await sqlRun(
      `UPDATE jira_webhook_events SET status = 'completed', processed_at = @now,
         error_code = NULL, updated_at = @now WHERE id = @eventId AND status = 'processing'`,
      { eventId, now },
    ) !== 1) throw new Error("The Jira webhook completion could not be persisted.");
    return result;
  } catch {
    const status = job.attempts >= job.maxAttempts ? "failed" : "pending";
    await sqlRun(
      `UPDATE jira_webhook_events SET status = @status, error_code = @errorCode,
         retry_count = GREATEST(retry_count, @retryCount), updated_at = @now
       WHERE id = @eventId AND status = 'processing'`,
      { eventId, status, errorCode: "integration_unavailable", retryCount: job.attempts, now: nowIso() },
    );
    throw new Error("Jira webhook reconciliation failed.");
  }
}

function parsePayload(payloadJson: string): { issueKey?: string; eventType?: string } {
  try {
    const payload = JSON.parse(payloadJson) as { webhookEvent?: unknown; issue?: { key?: unknown } };
    return {
      ...(typeof payload.issue?.key === "string" && payload.issue.key.trim() ? { issueKey: payload.issue.key.trim() } : {}),
      ...(typeof payload.webhookEvent === "string" ? { eventType: payload.webhookEvent } : {}),
    };
  } catch { throw new Error("The persisted Jira webhook payload is invalid."); }
}
