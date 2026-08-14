import "server-only";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import { createId, sqlGet } from "@/modules/shared/infrastructure/database/db";
import type { ZephyrRegion, ZephyrScaleSettings } from "./zephyr-scale-backend";
import { withAuthorizedJiraArtifactConfigurationLock } from "./jira-artifact-project-lock";

const REGIONS = new Set<ZephyrRegion>(["us", "eu", "au", "de"]);
type Row = { config_json: string; encrypted_secret: string; secret_iv: string; secret_tag: string; key_version: number; region: string; provider_project_key: string };

export async function storeZephyrScaleConfig(input: { workspaceId: string; projectId: string; actorUserId: string; apiToken: string; region: string; localIdFieldName: string }): Promise<void> {
  const workspaceId = input.workspaceId.trim(), projectId = input.projectId.trim(), actorUserId = input.actorUserId.trim();
  if (!workspaceId || !projectId || !actorUserId || !input.apiToken.trim() || !REGIONS.has(input.region as ZephyrRegion) || !input.localIdFieldName.trim() || input.localIdFieldName.length > 255) throw new Error("Zephyr Scale configuration is invalid.");
  const secret = encryptSecret(input.apiToken);
  const row = await withAuthorizedJiraArtifactConfigurationLock(
    { workspaceId, projectId, actorUserId },
    ({ client, now }) => sqlGet<{ id: string }>(
      `INSERT INTO jira_artifact_backend_configs (id, workspace_id, project_id, backend_type, config_json, encrypted_secret, secret_iv, secret_tag, key_version, region, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @projectId, 'zephyr_scale', @configJson, @encryptedSecret, @secretIv, @secretTag, @keyVersion, @region, 'active', @now, @now)
       ON CONFLICT (workspace_id, project_id) DO UPDATE SET backend_type = 'zephyr_scale', config_json = excluded.config_json, encrypted_secret = excluded.encrypted_secret, secret_iv = excluded.secret_iv, secret_tag = excluded.secret_tag, key_version = excluded.key_version, region = excluded.region, status = 'active', updated_at = excluded.updated_at RETURNING id`,
      { id: createId("jirabackend"), workspaceId, projectId, configJson: JSON.stringify({ localIdFieldName: input.localIdFieldName }), encryptedSecret: secret.ciphertext, secretIv: secret.iv, secretTag: secret.tag, keyVersion: secret.keyVersion, region: input.region, now },
      client,
    ),
  );
  if (!row) throw new Error("Zephyr Scale configuration is not authorized for this Jira project.");
}

export async function resolveZephyrScaleConfig(input: { workspaceId: string; projectId: string; actorUserId: string }): Promise<Omit<ZephyrScaleSettings, "assertJiraIssueInProject">> {
  const row = await sqlGet<Row>(
    `SELECT c.config_json, c.encrypted_secret, c.secret_iv, c.secret_tag, c.key_version, c.region, p.provider_project_key
     FROM jira_artifact_backend_configs c JOIN projects p ON p.workspace_id = c.workspace_id AND p.id = c.project_id AND p.provider_id = 'jira-cloud' AND p.status = 'active'
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = @actorUserId AND wm.status = 'active'
     WHERE c.workspace_id = @workspaceId AND c.project_id = @projectId AND c.backend_type = 'zephyr_scale' AND c.status = 'active'`, input,
  );
  if (!row || !REGIONS.has(row.region as ZephyrRegion) || !/^[A-Z][A-Z_0-9]+$/.test(row.provider_project_key)) throw new Error("Zephyr Scale configuration is not available for this Jira project.");
  let parsed: unknown; try { parsed = JSON.parse(row.config_json); } catch { throw new Error("Zephyr Scale configuration metadata is invalid."); }
  const field = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).localIdFieldName : undefined;
  if (typeof field !== "string" || !field.trim() || field.length > 255) throw new Error("Zephyr Scale configuration metadata is invalid.");
  return { apiToken: decryptSecret({ ciphertext: row.encrypted_secret, iv: row.secret_iv, tag: row.secret_tag, keyVersion: row.key_version }), region: row.region as ZephyrRegion, jiraProjectKey: row.provider_project_key, localIdFieldName: field };
}
