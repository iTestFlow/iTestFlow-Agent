import "server-only";

import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import { createId, nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";
import type { XrayCloudSettings } from "./xray-cloud-backend";

type ConfigRow = {
  config_json: string;
  encrypted_secret: string;
  secret_iv: string;
  secret_tag: string;
  key_version: number;
  provider_project_id: string;
  provider_project_key: string;
};

export async function storeXrayCloudConfig(input: {
  workspaceId: string; projectId: string; actorUserId: string; clientId: string; clientSecret: string; localIdFieldId: string;
}): Promise<void> {
  const workspaceId = nonblank(input.workspaceId);
  const projectId = nonblank(input.projectId);
  const actorUserId = nonblank(input.actorUserId);
  const clientId = nonblank(input.clientId);
  if (!workspaceId || !projectId || !actorUserId || !clientId || !input.clientSecret.trim() || !/^customfield_[0-9]+$/.test(input.localIdFieldId)) {
    throw new Error("Xray Cloud configuration is invalid.");
  }
  const secret = encryptSecret(input.clientSecret);
  const now = nowIso();
  const written = await sqlGet<{ id: string }>(
    `INSERT INTO jira_artifact_backend_configs (
       id, workspace_id, project_id, backend_type, config_json,
       encrypted_secret, secret_iv, secret_tag, key_version, region, status, created_at, updated_at
     )
     SELECT @id, p.workspace_id, p.id, 'xray_cloud', @configJson,
            @encryptedSecret, @secretIv, @secretTag, @keyVersion, 'global', 'active', @now, @now
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @actorUserId
       AND wm.status = 'active' AND wm.role IN ('owner', 'admin')
     WHERE p.workspace_id = @workspaceId AND p.id = @projectId
       AND p.provider_id = 'jira-cloud' AND p.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM jira_artifact_links l
         WHERE l.workspace_id = p.workspace_id AND l.project_id = p.id AND l.status = 'publishing'
       )
     ON CONFLICT (workspace_id, project_id) DO UPDATE SET
       backend_type = 'xray_cloud', config_json = excluded.config_json,
       encrypted_secret = excluded.encrypted_secret, secret_iv = excluded.secret_iv,
       secret_tag = excluded.secret_tag, key_version = excluded.key_version,
       region = excluded.region, status = 'active', updated_at = excluded.updated_at
     RETURNING id`,
    {
      id: createId("jirabackend"), workspaceId, projectId, actorUserId,
      configJson: JSON.stringify({ clientId, localIdFieldId: input.localIdFieldId }),
      encryptedSecret: secret.ciphertext, secretIv: secret.iv, secretTag: secret.tag, keyVersion: secret.keyVersion, now,
    },
  );
  if (!written) throw new Error("Xray Cloud configuration is not authorized for this Jira project.");
}

export async function resolveXrayCloudConfig(input: { workspaceId: string; projectId: string; actorUserId: string }): Promise<XrayCloudSettings> {
  const row = await sqlGet<ConfigRow>(
    `SELECT c.config_json, c.encrypted_secret, c.secret_iv, c.secret_tag, c.key_version,
            p.provider_project_id, p.provider_project_key
     FROM jira_artifact_backend_configs c
     JOIN projects p ON p.workspace_id = c.workspace_id AND p.id = c.project_id
       AND p.provider_id = 'jira-cloud' AND p.status = 'active'
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = @actorUserId AND wm.status = 'active'
     WHERE c.workspace_id = @workspaceId AND c.project_id = @projectId
       AND c.backend_type = 'xray_cloud' AND c.status = 'active'`,
    input,
  );
  if (!row) throw new Error("Xray Cloud configuration is not available for this Jira project.");
  const config = parseConfig(row.config_json);
  if (!row.provider_project_id?.trim() || !row.provider_project_key?.trim()) throw new Error("Xray Cloud Jira project identity is invalid.");
  return {
    clientId: config.clientId,
    clientSecret: decryptSecret({ ciphertext: row.encrypted_secret, iv: row.secret_iv, tag: row.secret_tag, keyVersion: row.key_version }),
    localIdFieldId: config.localIdFieldId,
    jiraProjectId: row.provider_project_id,
    jiraProjectKey: row.provider_project_key,
  };
}

function parseConfig(value: string): { clientId: string; localIdFieldId: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Xray Cloud configuration metadata is invalid."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Xray Cloud configuration metadata is invalid.");
  const record = parsed as Record<string, unknown>;
  if (typeof record.clientId !== "string" || !record.clientId.trim() || typeof record.localIdFieldId !== "string" || !/^customfield_[0-9]+$/.test(record.localIdFieldId)) {
    throw new Error("Xray Cloud configuration metadata is invalid.");
  }
  return { clientId: record.clientId, localIdFieldId: record.localIdFieldId };
}
function nonblank(value: string) { return typeof value === "string" ? value.trim() : ""; }
