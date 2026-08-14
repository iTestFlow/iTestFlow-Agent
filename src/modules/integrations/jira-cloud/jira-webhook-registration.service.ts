import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

const EVENTS = ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted"] as const;

export async function registerJiraProjectWebhook(input: {
  workspaceId: string; projectId: string; cloudId: string; accessToken: string; callbackUrl: string;
}): Promise<{ webhookId: string; expiresAt: string }> {
  const staleCutoff = new Date(Date.parse(nowIso()) - 10 * 60 * 1000).toISOString();
  const stale = await sqlGet<{ id: string; callback_key_hash: string }>(
    `SELECT j.id, j.callback_key_hash FROM jira_webhooks j
     JOIN projects p ON p.id = j.project_id AND p.workspace_id = j.workspace_id
     JOIN workspaces w ON w.id = j.workspace_id AND w.provider_site_id = j.cloud_id
     WHERE j.workspace_id = @workspaceId AND j.project_id = @projectId AND j.cloud_id = @cloudId
       AND ((j.status = 'registering' AND j.updated_at < @staleCutoff)
         OR (j.status = 'registration_error' AND j.last_error_code = 'registration_uncertain'))`,
    { workspaceId: input.workspaceId, projectId: input.projectId, cloudId: input.cloudId, staleCutoff },
  );
  if (stale) {
    const recovered = await recoverStaleRegistration(input.cloudId, input.accessToken, stale.callback_key_hash);
    if (recovered) {
      await sqlRun(
        `UPDATE jira_webhooks SET webhook_id = @webhookId, expires_at = @expiresAt,
           status = 'active', last_error_code = NULL, updated_at = @now
         WHERE id = @id AND status IN ('registering', 'registration_error')`,
        { id: stale.id, webhookId: recovered.webhookId, expiresAt: recovered.expiresAt, now: nowIso() },
      );
      return recovered;
    }
    await sqlRun(`DELETE FROM jira_webhooks WHERE id = @id AND status IN ('registering', 'registration_error')`, { id: stale.id });
  }
  const anchor = await sqlGet<{ project_key: string; webhook_id: string | null; webhook_status: string | null }>(
    `SELECT p.provider_project_key AS project_key, j.webhook_id, j.status AS webhook_status
     FROM projects p JOIN workspaces w ON w.id = p.workspace_id
     LEFT JOIN jira_webhooks j ON j.workspace_id = p.workspace_id AND j.project_id = p.id AND j.status <> 'disabled'
     WHERE p.id = @projectId AND p.workspace_id = @workspaceId
       AND p.provider_id = 'jira-cloud' AND p.status = 'active'
       AND w.provider_id = 'jira-cloud' AND w.provider_site_id = @cloudId AND w.status = 'active'`,
    { workspaceId: input.workspaceId, projectId: input.projectId, cloudId: input.cloudId },
  );
  if (!anchor?.project_key) throw new Error("Jira webhook registration is not authorized for this workspace project.");
  if (anchor.webhook_status === "registering") throw new Error("Jira webhook registration is already in progress.");
  if (anchor.webhook_status === "registration_error") throw new Error("Jira webhook registration requires reconciliation.");
  if (anchor.webhook_id) {
    return { webhookId: anchor.webhook_id, ...(await renewJiraProjectWebhook(input)) };
  }
  const callbackUrl = new URL(input.callbackUrl);
  if (callbackUrl.protocol !== "https:") throw new Error("Jira webhook callback URL must use HTTPS.");
  const callbackKey = randomBytes(32).toString("base64url");
  callbackUrl.searchParams.set("registration", callbackKey);
  const callbackKeyHash = createHash("sha256").update(callbackKey, "utf8").digest("hex");
  const now = nowIso();
  const claim = await sqlGet<{ id: string }>(
    `INSERT INTO jira_webhooks (id, workspace_id, project_id, cloud_id, webhook_id, expires_at, status, callback_key_hash, created_at, updated_at)
     VALUES (@id, @workspaceId, @projectId, @cloudId, NULL, NULL, 'registering', @callbackKeyHash, @now, @now)
     ON CONFLICT (workspace_id, project_id) DO NOTHING RETURNING id`,
    { id: createId("jirawebhook"), workspaceId: input.workspaceId, projectId: input.projectId, cloudId: input.cloudId, callbackKeyHash, now },
  );
  if (!claim) throw new Error("Jira webhook registration is already in progress.");
  let response: { webhookRegistrationResult?: Array<{ createdWebhookId?: number; errors?: string[] }> };
  try {
    response = await jiraWebhookRequest(input.cloudId, input.accessToken, "/webhook", {
      method: "POST",
      body: JSON.stringify({
        url: callbackUrl.toString(),
        webhooks: [{ jqlFilter: `project = ${jqlString(anchor.project_key)}`, events: EVENTS }],
      }),
    });
  } catch (error) {
    await sqlRun(
      `UPDATE jira_webhooks SET status = 'registration_error', last_error_code = 'registration_uncertain', updated_at = @now
       WHERE id = @id AND status = 'registering'`,
      { id: claim.id, now: nowIso() },
    );
    throw error;
  }
  const webhookId = response.webhookRegistrationResult?.[0]?.createdWebhookId;
  if (!webhookId) {
    await sqlRun(`DELETE FROM jira_webhooks WHERE id = @id AND status = 'registering'`, { id: claim.id });
    throw new Error("Jira webhook registration failed.");
  }
  const expiresAt = new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString();
  let written = 0;
  try {
    written = await sqlRun(
      `UPDATE jira_webhooks SET webhook_id = @webhookId, expires_at = @expiresAt,
         status = 'active', last_error_code = NULL, updated_at = @now
       WHERE id = @id AND status = 'registering'`,
      { id: claim.id, webhookId: String(webhookId), expiresAt, now },
    );
  } catch {
    await compensateAndClear(input.cloudId, input.accessToken, String(webhookId), claim.id);
    throw new Error("Jira webhook registration could not be persisted.");
  }
  if (written !== 1) {
    await compensateAndClear(input.cloudId, input.accessToken, String(webhookId), claim.id);
    throw new Error("Jira webhook registration could not be persisted.");
  }
  return { webhookId: String(webhookId), expiresAt };
}

async function recoverStaleRegistration(cloudId: string, accessToken: string, callbackKeyHash: string) {
  let startAt = 0;
  while (true) {
    const page = await jiraWebhookRequest<{
      values?: Array<{ id?: number; url?: string; expirationDate?: string }>;
      total?: number; startAt?: number; maxResults?: number;
    }>(cloudId, accessToken, `/webhook?startAt=${startAt}&maxResults=100`, { method: "GET" });
    for (const webhook of page.values ?? []) {
      const token = webhook.url ? safeRegistrationToken(webhook.url) : undefined;
      const hash = token ? createHash("sha256").update(token, "utf8").digest("hex") : undefined;
      if (hash === callbackKeyHash && webhook.id && webhook.expirationDate) {
        return { webhookId: String(webhook.id), expiresAt: new Date(webhook.expirationDate).toISOString() };
      }
    }
    const pageSize = page.maxResults ?? page.values?.length ?? 0;
    startAt = (page.startAt ?? startAt) + pageSize;
    if (!pageSize || page.total === undefined || startAt >= page.total) return null;
  }
}

async function compensateWebhook(cloudId: string, accessToken: string, webhookId: string) {
  try {
    await jiraWebhookRequest<unknown>(cloudId, accessToken, "/webhook", {
      method: "DELETE", body: JSON.stringify({ webhookIds: [Number(webhookId)] }),
    });
  } catch {
    throw new Error("Jira webhook registration requires reconciliation.");
  }
}

async function compensateAndClear(cloudId: string, accessToken: string, webhookId: string, claimId: string) {
  try {
    await compensateWebhook(cloudId, accessToken, webhookId);
    await sqlRun(`DELETE FROM jira_webhooks WHERE id = @id AND status = 'registering'`, { id: claimId });
  } catch {
    await sqlRun(
      `UPDATE jira_webhooks SET webhook_id = @webhookId, status = 'registration_error',
         last_error_code = 'compensation_failed', updated_at = @now WHERE id = @id`,
      { id: claimId, webhookId, now: nowIso() },
    );
    throw new Error("Jira webhook registration requires reconciliation.");
  }
}

export async function renewJiraProjectWebhook(input: {
  workspaceId: string; projectId: string; accessToken: string;
}): Promise<{ expiresAt: string }> {
  const webhook = await sqlGet<{ webhook_id: string; cloud_id: string }>(
    `SELECT j.webhook_id, j.cloud_id FROM jira_webhooks j
     JOIN workspaces w ON w.id = j.workspace_id
     WHERE j.workspace_id = @workspaceId AND j.project_id = @projectId
       AND j.status <> 'disabled' AND w.status = 'active' AND w.provider_site_id = j.cloud_id`,
    { workspaceId: input.workspaceId, projectId: input.projectId },
  );
  if (!webhook) throw new Error("No renewable Jira webhook is available.");
  const response = await jiraWebhookRequest<{ expirationDate?: string }>(webhook.cloud_id, input.accessToken, "/webhook/refresh", {
    method: "PUT", body: JSON.stringify({ webhookIds: [Number(webhook.webhook_id)] }),
  });
  const expiresAt = response.expirationDate ? new Date(response.expirationDate).toISOString() : undefined;
  if (!expiresAt) throw new Error("Jira webhook renewal returned an invalid expiry.");
  const written = await sqlRun(
    `UPDATE jira_webhooks SET expires_at = @expiresAt, status = 'active', last_error_code = NULL, updated_at = @now
     WHERE workspace_id = @workspaceId AND project_id = @projectId AND webhook_id = @webhookId`,
    { workspaceId: input.workspaceId, projectId: input.projectId, webhookId: webhook.webhook_id, expiresAt, now: nowIso() },
  );
  if (written !== 1) throw new Error("Jira webhook renewal could not be persisted.");
  return { expiresAt };
}

async function jiraWebhookRequest<T>(cloudId: string, accessToken: string, path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId.trim())}/rest/api/3${path}`, {
      ...init, cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
    });
  } catch { throw new Error("Jira webhook service is unavailable."); }
  if (!response.ok) throw new Error("Jira webhook request failed.");
  if (response.status === 202 || response.status === 204) return undefined as T;
  try { return await response.json() as T; } catch { throw new Error("Jira webhook service returned an invalid response."); }
}

function jqlString(value: string) { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }
function safeRegistrationToken(value: string) {
  try { return new URL(value).searchParams.get("registration") ?? undefined; } catch { return undefined; }
}
