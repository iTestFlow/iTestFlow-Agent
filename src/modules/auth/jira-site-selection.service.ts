import "server-only";

import { createHash, randomBytes } from "crypto";
import { z } from "zod";

import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import { isAllowedAtlassianCloudId, type AtlassianAccessibleResource } from "./jira-oauth";

const ResourcesSchema = z.array(z.object({
  id: z.string().min(1), name: z.string().min(1), url: z.string().url(), scopes: z.array(z.string()),
})).min(2);
const TTL_MS = 10 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export async function createJiraSiteSelection(input: {
  browserBinding: string;
  returnTo: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string;
  resources: AtlassianAccessibleResource[];
}): Promise<string> {
  if (!input.browserBinding.trim() || !input.accessToken.trim() || !input.refreshToken.trim()) {
    throw new Error("Jira site selection credentials and browser binding are required.");
  }
  const resources = ResourcesSchema.parse(input.resources);
  if (resources.some((resource) => !isAllowedAtlassianCloudId(resource.id))) {
    throw new Error("Jira site selection contains an unapproved site.");
  }
  const access = encryptSecret(input.accessToken);
  const refresh = encryptSecret(input.refreshToken);
  if (access.keyVersion !== refresh.keyVersion) throw new Error("Jira OAuth token encryption key versions do not match.");
  const continuation = randomBytes(32).toString("base64url");
  const now = nowIso();
  await sqlRun(
    `INSERT INTO jira_oauth_selections (
       id, continuation_hash, browser_binding_hash,
       encrypted_access_token, access_token_iv, access_token_tag,
       encrypted_refresh_token, refresh_token_iv, refresh_token_tag, key_version,
       access_expires_at, scopes, resources_json, return_to, created_at, expires_at
     ) VALUES (
       @id, @continuationHash, @browserBindingHash,
       @encryptedAccessToken, @accessTokenIv, @accessTokenTag,
       @encryptedRefreshToken, @refreshTokenIv, @refreshTokenTag, @keyVersion,
       @accessExpiresAt, @scopes, @resourcesJson, @returnTo, @now, @expiresAt
     )`,
    {
      id: createId("jiraselect"), continuationHash: hash(continuation), browserBindingHash: hash(input.browserBinding),
      encryptedAccessToken: access.ciphertext, accessTokenIv: access.iv, accessTokenTag: access.tag,
      encryptedRefreshToken: refresh.ciphertext, refreshTokenIv: refresh.iv, refreshTokenTag: refresh.tag,
      keyVersion: access.keyVersion,
      accessExpiresAt: new Date(Date.parse(now) + input.expiresInSeconds * 1000).toISOString(),
      scopes: input.scopes,
      resourcesJson: JSON.stringify(resources), returnTo: input.returnTo, now,
      expiresAt: new Date(Date.parse(now) + TTL_MS).toISOString(),
    },
  );
  return continuation;
}

type SelectionRow = {
  encrypted_access_token: string; access_token_iv: string; access_token_tag: string;
  encrypted_refresh_token: string; refresh_token_iv: string; refresh_token_tag: string;
  key_version: number; access_expires_at: string; scopes: string; resources_json: string; return_to: string;
};

export async function getJiraSiteSelectionOptions(continuation: string, browserBinding: string) {
  if (!continuation.trim() || !browserBinding.trim()) throw new Error("Jira site selection is invalid.");
  const row = await sqlGet<{ resources_json: string }>(
    `SELECT resources_json FROM jira_oauth_selections
     WHERE continuation_hash = @continuationHash AND browser_binding_hash = @browserBindingHash AND expires_at > @now
     LIMIT 1`,
    { continuationHash: hash(continuation), browserBindingHash: hash(browserBinding), now: nowIso() },
  );
  if (!row) throw new Error("Jira site selection is invalid or expired.");
  return ResourcesSchema.parse(JSON.parse(row.resources_json)).map(({ id, name, url }) => ({ id, name, url }));
}

export async function consumeJiraSiteSelection(continuation: string, browserBinding: string, cloudId: string) {
  const selectedCloudId = cloudId.trim();
  if (!continuation.trim() || !browserBinding.trim() || !isAllowedAtlassianCloudId(selectedCloudId)) {
    throw new Error("Jira selected site continuation is invalid.");
  }
  const row = await sqlGet<SelectionRow>(
    `DELETE FROM jira_oauth_selections
     WHERE continuation_hash = @continuationHash AND browser_binding_hash = @browserBindingHash AND expires_at > @now
     RETURNING encrypted_access_token, access_token_iv, access_token_tag,
               encrypted_refresh_token, refresh_token_iv, refresh_token_tag, key_version,
               access_expires_at, scopes, resources_json, return_to`,
    { continuationHash: hash(continuation), browserBindingHash: hash(browserBinding), now: nowIso() },
  );
  if (!row) throw new Error("Jira site selection is invalid, expired, or already used.");
  const resources = ResourcesSchema.parse(JSON.parse(row.resources_json));
  const resource = resources.find((candidate) => candidate.id === selectedCloudId);
  if (!resource) throw new Error("Jira selected site is not part of this authorization.");
  const expiresInSeconds = Math.floor((Date.parse(row.access_expires_at) - Date.parse(nowIso())) / 1000);
  if (expiresInSeconds <= 0) throw new Error("Jira site selection access token has expired. Start again.");
  return {
    resource,
    accessToken: decryptSecret({ ciphertext: row.encrypted_access_token, iv: row.access_token_iv, tag: row.access_token_tag, keyVersion: row.key_version }),
    refreshToken: decryptSecret({ ciphertext: row.encrypted_refresh_token, iv: row.refresh_token_iv, tag: row.refresh_token_tag, keyVersion: row.key_version }),
    expiresInSeconds,
    scopes: row.scopes,
    returnTo: row.return_to,
  };
}
