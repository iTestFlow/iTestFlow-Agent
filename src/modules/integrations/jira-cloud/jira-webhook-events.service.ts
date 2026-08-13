import "server-only";

import { createHash } from "node:crypto";
import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

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
  const written = await sqlRun(
    `INSERT INTO jira_webhook_events (
       id, workspace_id, project_id, cloud_id, delivery_id, event_type, issue_id,
       payload_hash, payload_json, status, retry_count, received_at, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @cloudId, @deliveryId, @eventType, @issueId,
       @payloadHash, @payloadJson, 'pending', @retryCount, @now, @now, @now
     )
     ON CONFLICT (cloud_id, delivery_id) DO NOTHING`,
    {
      id: createId("jiraevent"), workspaceId: registration.workspace_id, projectId: registration.project_id,
      cloudId: registration.cloud_id, deliveryId,
      eventType: input.payload.webhookEvent ?? "unknown", issueId: input.payload.issue?.id ? String(input.payload.issue.id) : null,
      payloadHash: createHash("sha256").update(input.rawPayload, "utf8").digest("hex"),
      payloadJson: input.rawPayload, retryCount: Math.max(0, Math.trunc(input.retryCount) || 0), now,
    },
  );
  return { accepted: true, duplicate: written === 0 };
}

export class JiraWebhookRejectedError extends Error {}
