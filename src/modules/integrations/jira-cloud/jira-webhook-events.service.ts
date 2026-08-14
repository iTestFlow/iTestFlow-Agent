import "server-only";

import { createHash } from "node:crypto";
import { enqueueJob } from "@/modules/jobs/job-queue.service";
import { createId, nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";

export const JIRA_WEBHOOK_RECONCILE = "jira_webhook_reconcile";

type JiraWebhookPayload = {
  webhookEvent?: string;
  matchedWebhookIds?: Array<string | number>;
  issue?: { id?: string | number; key?: string };
};

export async function acceptJiraWebhookEvent(input: {
  deliveryId: string;
  registrationToken: string;
  retryCount: number;
  payload: JiraWebhookPayload;
  rawPayload: string;
}): Promise<{ accepted: true; duplicate: boolean }> {
  const deliveryId = input.deliveryId.trim();
  if (!deliveryId) throw new JiraWebhookRejectedError("The Jira webhook delivery identifier is required.");
  const registrationToken = input.registrationToken.trim();
  if (!registrationToken) throw new JiraWebhookRejectedError("The Jira webhook registration token is required.");
  const webhookIds = (input.payload.matchedWebhookIds ?? []).map(String).filter(Boolean);
  if (!webhookIds.length) throw new JiraWebhookRejectedError("The Jira webhook did not identify a registered webhook.");
  const registration = await sqlGet<{ workspace_id: string; project_id: string; cloud_id: string }>(
    `SELECT workspace_id, project_id, cloud_id
     FROM jira_webhooks
     WHERE callback_key_hash = @callbackKeyHash AND webhook_id = ANY(@webhookIds::text[])
       AND status = 'active' AND expires_at > @now
     LIMIT 1`,
    { webhookIds, callbackKeyHash: createHash("sha256").update(registrationToken, "utf8").digest("hex"), now: nowIso() },
  );
  if (!registration) throw new JiraWebhookRejectedError("The event does not match an active registered Jira webhook.");
  const now = nowIso();
  const eventId = createId("jiraevent");
  const event = await sqlGet<{ id: string; inserted: boolean; status: "pending" | "processing" | "completed" | "failed" }>(
    `WITH attempted AS (
       INSERT INTO jira_webhook_events (
       id, workspace_id, project_id, cloud_id, delivery_id, event_type, issue_id,
       payload_hash, payload_json, status, retry_count, received_at, created_at, updated_at
       ) VALUES (
       @id, @workspaceId, @projectId, @cloudId, @deliveryId, @eventType, @issueId,
       @payloadHash, @payloadJson, 'pending', @retryCount, @now, @now, @now
       )
       ON CONFLICT (cloud_id, delivery_id) DO NOTHING
       RETURNING id, status
     )
     SELECT id, true AS inserted, status FROM attempted
     UNION ALL
     SELECT id, false AS inserted, status FROM jira_webhook_events
     WHERE cloud_id = @cloudId AND delivery_id = @deliveryId AND NOT EXISTS (SELECT 1 FROM attempted)
     LIMIT 1`,
    {
      id: eventId, workspaceId: registration.workspace_id, projectId: registration.project_id,
      cloudId: registration.cloud_id, deliveryId,
      eventType: input.payload.webhookEvent ?? "unknown", issueId: input.payload.issue?.id ? String(input.payload.issue.id) : null,
      payloadHash: createHash("sha256").update(input.rawPayload, "utf8").digest("hex"),
      payloadJson: input.rawPayload, retryCount: Math.max(0, Math.trunc(input.retryCount) || 0), now,
    },
  );
  if (!event) throw new Error("Jira webhook delivery could not be persisted.");
  if (event.inserted || event.status === "pending" || event.status === "processing") {
    await enqueueJob({
      jobType: JIRA_WEBHOOK_RECONCILE,
      workspaceId: registration.workspace_id,
      projectId: registration.project_id,
      payload: { eventId: event.id },
      dedupeKey: `jira_webhook:${event.id}`,
      maxAttempts: 5,
      createdByUserId: null,
    });
  }
  return { accepted: true, duplicate: !event.inserted };
}

export class JiraWebhookRejectedError extends Error {}
