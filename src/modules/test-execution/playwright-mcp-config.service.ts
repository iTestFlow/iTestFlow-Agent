import "server-only";

import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";

export type PlaywrightMcpTransport = "http" | "stdio";

export type PlaywrightMcpConfigSummary = {
  status: "not_configured" | "configured" | "disabled";
  transport: PlaywrightMcpTransport | null;
  endpoint: string | null;
  artifactBaseUrl: string | null;
};

export type ResolvedPlaywrightMcpConfig = PlaywrightMcpConfigSummary & {
  bearerToken: string | null;
};

type ConfigRow = {
  transport: PlaywrightMcpTransport;
  endpoint: string | null;
  artifact_base_url: string | null;
  encrypted_bearer_token: string | null;
  bearer_token_iv: string | null;
  bearer_token_tag: string | null;
  bearer_token_key_version: number | null;
  enabled: boolean;
};

async function getRow(workspaceId: string): Promise<ConfigRow | undefined> {
  return sqlGet<ConfigRow>(
    `SELECT transport, endpoint, artifact_base_url, encrypted_bearer_token,
            bearer_token_iv, bearer_token_tag, bearer_token_key_version, enabled
       FROM playwright_mcp_configs WHERE workspace_id = @workspaceId`,
    { workspaceId },
  );
}

function summary(row: ConfigRow | undefined): PlaywrightMcpConfigSummary {
  if (!row) return { status: "not_configured", transport: null, endpoint: null, artifactBaseUrl: null };
  return {
    status: row.enabled ? "configured" : "disabled",
    transport: row.transport,
    endpoint: row.endpoint,
    artifactBaseUrl: row.artifact_base_url,
  };
}

export async function getPlaywrightMcpConfigSummary(workspaceId: string): Promise<PlaywrightMcpConfigSummary> {
  return summary(await getRow(workspaceId));
}

export async function resolvePlaywrightMcpConfig(workspaceId: string): Promise<ResolvedPlaywrightMcpConfig | null> {
  const row = await getRow(workspaceId);
  if (!row) return null;
  const encrypted = row.encrypted_bearer_token;
  return {
    ...summary(row),
    bearerToken: encrypted
      ? decryptSecret({
          ciphertext: encrypted,
          iv: row.bearer_token_iv!,
          tag: row.bearer_token_tag!,
          keyVersion: row.bearer_token_key_version!,
        })
      : null,
  };
}

export async function savePlaywrightMcpConfig(input: {
  workspaceId: string;
  userId: string;
  transport: PlaywrightMcpTransport;
  endpoint?: string | null;
  artifactBaseUrl?: string | null;
  bearerToken?: string | null;
  enabled?: boolean;
}): Promise<PlaywrightMcpConfigSummary> {
  const existing = await getRow(input.workspaceId);
  const encrypted = input.bearerToken ? encryptSecret(input.bearerToken) : null;
  const preserveToken = input.transport === "http" && input.bearerToken === undefined && existing?.encrypted_bearer_token;
  const now = nowIso();
  await sqlRun(
    `INSERT INTO playwright_mcp_configs (
       workspace_id, transport, endpoint, artifact_base_url, encrypted_bearer_token,
       bearer_token_iv, bearer_token_tag, bearer_token_key_version, enabled,
       created_by_user_id, updated_by_user_id, created_at, updated_at
     ) VALUES (
       @workspaceId, @transport, @endpoint, @artifactBaseUrl, @encryptedToken,
       @tokenIv, @tokenTag, @keyVersion, @enabled, @userId, @userId, @now, @now
     ) ON CONFLICT (workspace_id) DO UPDATE SET
       transport = excluded.transport, endpoint = excluded.endpoint,
       artifact_base_url = excluded.artifact_base_url,
       encrypted_bearer_token = excluded.encrypted_bearer_token,
       bearer_token_iv = excluded.bearer_token_iv,
       bearer_token_tag = excluded.bearer_token_tag,
       bearer_token_key_version = excluded.bearer_token_key_version,
       enabled = excluded.enabled, updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
    {
      workspaceId: input.workspaceId,
      transport: input.transport,
      endpoint: input.transport === "http" ? input.endpoint ?? null : null,
      artifactBaseUrl: input.transport === "http" ? input.artifactBaseUrl ?? null : null,
      encryptedToken: preserveToken ? existing!.encrypted_bearer_token : encrypted?.ciphertext ?? null,
      tokenIv: preserveToken ? existing!.bearer_token_iv : encrypted?.iv ?? null,
      tokenTag: preserveToken ? existing!.bearer_token_tag : encrypted?.tag ?? null,
      keyVersion: preserveToken ? existing!.bearer_token_key_version : encrypted?.keyVersion ?? null,
      enabled: input.enabled ?? true,
      userId: input.userId,
      now,
    },
  );
  return getPlaywrightMcpConfigSummary(input.workspaceId);
}
