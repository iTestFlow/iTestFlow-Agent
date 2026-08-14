import "server-only";

import type { PoolClient } from "pg";
import type { FinalApprovedTestCase } from "../core/integration-types";
import { createId, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { resolveJiraAccessToken } from "@/modules/auth/jira-connection.service";
import { JiraCloudAdapter } from "./jira-cloud-adapter";
import { PlainJiraArtifactBackend } from "./plain-jira-artifact-backend";
import { XrayCloudBackend } from "./xray-cloud-backend";
import { resolveXrayCloudConfigRow } from "./xray-cloud-config.service";
import { ZephyrScaleBackend } from "./zephyr-scale-backend";
import { resolveZephyrScaleConfigRow } from "./zephyr-scale-config.service";
import { retireStaleJiraArtifactClaims, withAuthorizedJiraArtifactConfigurationLock, withJiraArtifactProjectLock } from "./jira-artifact-project-lock";

type PlainPublisher = { createTestCase(input: { projectId: string; testCase: FinalApprovedTestCase }): Promise<{ success: boolean; azureTestCaseId?: string; error?: string }> };
type LinkRow = { backend_type?: BackendType; remote_artifact_id: string; remote_url: string };
type BackendType = "plain_jira" | "xray_cloud" | "zephyr_scale";
type BackendAnchor = {
  backend_type: BackendType; config_json: string; provider_project_id: string; provider_project_key: string;
  provider_project_name: string; provider_site_id: string; provider_site_url: string;
  encrypted_secret: string; secret_iv: string; secret_tag: string; key_version: number; region: string;
};
type ResolvedBackend = { backend: PlainPublisher; backendType: BackendType; siteUrl: string };

export async function publishConfiguredJiraTestCases(input: {
  workspaceId: string; projectId: string; actorUserId: string; testCases: FinalApprovedTestCase[];
}) {
  const results = [];
  for (const testCase of input.testCases) {
    try {
      const accessToken = await resolveJiraAccessToken({ workspaceId: input.workspaceId, userId: input.actorUserId });
      const published = await publishJiraTestCase({
        ...input,
        testCase,
        resolveBackend: (client) => resolveConfiguredBackend(input, accessToken, client),
      });
      results.push({
        localId: testCase.localId, azureTestCaseId: published.remoteId, success: true,
        create: { success: true, azureTestCaseId: published.remoteId }, link: { success: true }, suite: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Jira artifact publishing failed.";
      results.push({
        localId: testCase.localId, success: false,
        create: { success: false, error: message }, link: { success: false, error: message }, suite: undefined,
      });
    }
  }
  return { results };
}

export async function storePlainJiraArtifactConfig(input: {
  workspaceId: string; projectId: string; actorUserId: string; testCaseIssueTypeId: string; localIdFieldId: string;
}): Promise<void> {
  const workspaceId = input.workspaceId.trim();
  const projectId = input.projectId.trim();
  const actorUserId = input.actorUserId.trim();
  const testCaseIssueTypeId = input.testCaseIssueTypeId.trim();
  const localIdFieldId = input.localIdFieldId.trim();
  if (!workspaceId || !projectId || !actorUserId || !/^[1-9][0-9]*$/.test(testCaseIssueTypeId) || !/^customfield_[0-9]+$/.test(localIdFieldId)) {
    throw new Error("Plain Jira artifact configuration is invalid.");
  }
  const row = await withAuthorizedJiraArtifactConfigurationLock(
    { workspaceId, projectId, actorUserId },
    ({ client }) => sqlGet<{ id: string }>(
      `INSERT INTO jira_artifact_backend_configs (
         id, workspace_id, project_id, backend_type, config_json, encrypted_secret, secret_iv, secret_tag, key_version, region, status, created_at, updated_at
       )
       VALUES (@id, @workspaceId, @projectId, 'plain_jira', @configJson, NULL, NULL, NULL, NULL, NULL, 'active', clock_timestamp(), clock_timestamp())
       ON CONFLICT (workspace_id, project_id) DO UPDATE SET
         backend_type = 'plain_jira', config_json = excluded.config_json,
         encrypted_secret = NULL, secret_iv = NULL, secret_tag = NULL, key_version = NULL, region = NULL,
         status = 'active', updated_at = clock_timestamp()
       RETURNING id`,
      {
        id: createId("jirabackend"), workspaceId, projectId,
        configJson: JSON.stringify({ testCaseIssueTypeId, localIdFieldId }),
      },
      client,
    ),
  );
  if (!row) throw new Error("Plain Jira artifact configuration is not authorized for this project.");
}

export async function publishPlainJiraTestCase(input: {
  workspaceId: string; projectId: string; actorUserId: string; testCase: FinalApprovedTestCase;
  backend: PlainPublisher; siteUrl?: string;
}): Promise<{ remoteId: string; remoteUrl: string; created: boolean }> {
  return publishJiraTestCase({ ...input, backendType: "plain_jira" });
}

async function publishJiraTestCase(input: {
  workspaceId: string; projectId: string; actorUserId: string; testCase: FinalApprovedTestCase;
  backend?: PlainPublisher; backendType?: BackendType; siteUrl?: string;
  resolveBackend?: (client: PoolClient) => Promise<ResolvedBackend>;
}): Promise<{ remoteId: string; remoteUrl: string; created: boolean }> {
  const params = { workspaceId: input.workspaceId, projectId: input.projectId, localType: "test_case", localId: input.testCase.localId };
  const claimed = await withJiraArtifactProjectLock(params, async (lock) => {
    const { client } = lock;
    const resolved = input.resolveBackend
      ? await input.resolveBackend(client)
      : input.backend && input.backendType
        ? { backend: input.backend, backendType: input.backendType, siteUrl: input.siteUrl ?? "" }
        : undefined;
    if (!resolved) throw new Error("A Jira artifact backend is not configured for this project.");
    const authorized = await sqlGet<{ provider_project_id: string; provider_project_key: string }>(
      `SELECT p.provider_project_id, p.provider_project_key
       FROM projects p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @userId AND wm.status = 'active'
       JOIN jira_artifact_backend_configs c ON c.workspace_id = p.workspace_id AND c.project_id = p.id
         AND c.backend_type = @backendType AND c.status = 'active'
       WHERE p.id = @projectId AND p.workspace_id = @workspaceId
         AND p.provider_id = 'jira-cloud' AND p.status = 'active'`,
      { ...params, userId: input.actorUserId, backendType: resolved.backendType },
      client,
    );
    if (!authorized?.provider_project_id) throw new Error("Jira publishing is not authorized for this workspace project.");
    await retireStaleJiraArtifactClaims(params, lock);
    const existing = await sqlGet<LinkRow>(
      `SELECT backend_type, remote_artifact_id, remote_url FROM jira_artifact_links
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND local_artifact_type = @localType AND local_artifact_id = @localId AND status = 'active'`,
      params,
      client,
    );
    if (existing?.backend_type === resolved.backendType || (existing && resolved.backendType === "plain_jira" && !existing.backend_type)) {
      return { kind: "existing", existing } as const;
    }
    const claim = await sqlGet<{ id: string }>(
      `INSERT INTO jira_artifact_links (
         id, workspace_id, project_id, backend_type, local_artifact_type, local_artifact_id,
         remote_artifact_id, remote_url, status, created_at, updated_at
       )
       VALUES (@id, @workspaceId, @projectId, @backendType, @localType, @localId,
               NULL, NULL, 'publishing', clock_timestamp(), clock_timestamp())
       ON CONFLICT (workspace_id, project_id, local_artifact_type, local_artifact_id)
       DO UPDATE SET id = excluded.id, backend_type = excluded.backend_type,
         remote_artifact_id = NULL, remote_url = NULL, status = 'publishing',
         created_at = excluded.created_at, updated_at = excluded.updated_at
       WHERE jira_artifact_links.status IN ('error', 'missing_remote')
          OR (jira_artifact_links.status = 'active' AND jira_artifact_links.backend_type <> @backendType)
       RETURNING id`,
      { ...params, id: createId("jiraartifact"), backendType: resolved.backendType },
      client,
    );
    if (!claim) throw new Error("This iTestFlow artifact is already being published.");
    return { kind: "claimed", claim, authorized, resolved } as const;
  });
  if (claimed.kind === "existing") {
    return { remoteId: claimed.existing.remote_artifact_id, remoteUrl: claimed.existing.remote_url, created: false };
  }
  const backendProjectId = claimed.resolved.backendType === "zephyr_scale" ? claimed.authorized.provider_project_key : claimed.authorized.provider_project_id;
  let published: Awaited<ReturnType<PlainPublisher["createTestCase"]>>;
  try {
    published = await claimed.resolved.backend.createTestCase({ projectId: backendProjectId, testCase: input.testCase });
    if (!published.success || !published.azureTestCaseId) throw new Error("Jira test-case publishing failed.");
  } catch (error) {
    await failOwnedClaim(params, claimed.claim.id);
    throw error;
  }
  const remoteId = published.azureTestCaseId;
  const remoteBaseUrl = claimed.resolved.siteUrl.replace(/\/+$/, "");
  const remoteUrl = claimed.resolved.backendType === "zephyr_scale"
    ? `${remoteBaseUrl}/secure/Tests.jspa#/testCase/${encodeURIComponent(remoteId)}`
    : `${remoteBaseUrl}/browse/${encodeURIComponent(remoteId)}`;
  const linked = await withJiraArtifactProjectLock(params, async (lock) => {
    await retireStaleJiraArtifactClaims(params, lock);
    return sqlGet<LinkRow>(
      `UPDATE jira_artifact_links l SET remote_artifact_id = @remoteId, remote_url = @remoteUrl,
         status = 'active', updated_at = clock_timestamp()
       WHERE l.id = @id AND l.workspace_id = @workspaceId AND l.project_id = @projectId AND l.status = 'publishing'
         AND EXISTS (
           SELECT 1 FROM jira_artifact_backend_configs c
           WHERE c.workspace_id = l.workspace_id AND c.project_id = l.project_id
             AND c.backend_type = @backendType AND c.status = 'active'
         )
       RETURNING l.remote_artifact_id, l.remote_url`,
      { ...params, id: claimed.claim.id, backendType: claimed.resolved.backendType, remoteId, remoteUrl },
      lock.client,
    );
  });
  if (!linked) throw new Error("The Jira artifact link is not authorized for this workspace project.");
  return { remoteId: linked.remote_artifact_id, remoteUrl: linked.remote_url, created: true };
}

async function failOwnedClaim(
  params: { workspaceId: string; projectId: string; localType: string; localId: string },
  claimId: string,
): Promise<void> {
  await withJiraArtifactProjectLock(params, async (lock) => {
    await retireStaleJiraArtifactClaims(params, lock);
    await sqlRun(
      `UPDATE jira_artifact_links SET status = 'error', updated_at = clock_timestamp()
       WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId AND status = 'publishing'`,
      { ...params, id: claimId },
      lock.client,
    );
  });
}

async function resolveConfiguredBackend(
  input: { workspaceId: string; projectId: string; actorUserId: string },
  accessToken: string,
  client: PoolClient,
): Promise<ResolvedBackend> {
  const anchor = await sqlGet<BackendAnchor>(
    `SELECT c.backend_type, c.config_json, c.encrypted_secret, c.secret_iv, c.secret_tag, c.key_version, c.region,
            p.provider_project_id, p.provider_project_key, p.provider_project_name,
            w.provider_site_id, w.provider_site_url
     FROM jira_artifact_backend_configs c
     JOIN projects p ON p.workspace_id = c.workspace_id AND p.id = c.project_id AND p.provider_id = 'jira-cloud' AND p.status = 'active'
     JOIN workspaces w ON w.id = p.workspace_id AND w.provider_id = 'jira-cloud' AND w.status = 'active'
     JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = @actorUserId AND wm.status = 'active'
     WHERE c.workspace_id = @workspaceId AND c.project_id = @projectId AND c.status = 'active'`,
    input,
    client,
  );
  if (!anchor) throw new Error("A Jira artifact backend is not configured for this project.");
  if (anchor.backend_type === "xray_cloud") {
    return { backend: new XrayCloudBackend(resolveXrayCloudConfigRow(anchor)), backendType: anchor.backend_type, siteUrl: anchor.provider_site_url };
  }
  if (anchor.backend_type === "zephyr_scale") {
    const jira = new JiraCloudAdapter({
      cloudId: anchor.provider_site_id, siteUrl: anchor.provider_site_url, accessToken,
    }, {
      jiraProjectId: anchor.provider_project_id, jiraProjectKey: anchor.provider_project_key, jiraProjectName: anchor.provider_project_name,
    });
    const settings = resolveZephyrScaleConfigRow(anchor);
    return {
      backend: new ZephyrScaleBackend({
        ...settings,
        assertJiraIssueInProject: async (issueKey) => {
          const issues = await jira.fetchWorkItemsByIds({ projectId: anchor.provider_project_id, workItemIds: [String(issueKey)] });
          if (issues.length !== 1) throw new Error("The target Jira issue is not in the selected project.");
        },
      }),
      backendType: anchor.backend_type,
      siteUrl: anchor.provider_site_url,
    };
  }
  const config = parsePlainConfig(anchor.config_json);
  const appBaseUrl = process.env.ITESTFLOW_PUBLIC_URL?.trim();
  if (!appBaseUrl) throw new Error("Plain Jira artifact publishing is not configured for this deployment.");
  return {
    backend: new PlainJiraArtifactBackend({
      cloudId: anchor.provider_site_id, siteUrl: anchor.provider_site_url, accessToken, appBaseUrl,
      testCaseIssueTypeId: config.testCaseIssueTypeId, localIdFieldId: config.localIdFieldId,
    }, {
      jiraProjectId: anchor.provider_project_id, jiraProjectKey: anchor.provider_project_key, jiraProjectName: anchor.provider_project_name,
    }),
    backendType: anchor.backend_type,
    siteUrl: anchor.provider_site_url,
  };
}

function parsePlainConfig(value: string): { testCaseIssueTypeId: string; localIdFieldId: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Plain Jira artifact configuration metadata is invalid."); }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (typeof record.testCaseIssueTypeId !== "string" || !/^[1-9][0-9]*$/.test(record.testCaseIssueTypeId)
      || typeof record.localIdFieldId !== "string" || !/^customfield_[0-9]+$/.test(record.localIdFieldId)) {
    throw new Error("Plain Jira artifact configuration metadata is invalid.");
  }
  return { testCaseIssueTypeId: record.testCaseIssueTypeId, localIdFieldId: record.localIdFieldId };
}
