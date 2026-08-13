import "server-only";

import type { FinalApprovedTestCase } from "../core/integration-types";
import { createId, nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";

type PlainPublisher = { createTestCase(input: { projectId: string; testCase: FinalApprovedTestCase }): Promise<{ success: boolean; azureTestCaseId?: string; error?: string }> };
type LinkRow = { remote_artifact_id: string; remote_url: string };

export async function publishPlainJiraTestCase(input: {
  workspaceId: string; projectId: string; actorUserId: string; testCase: FinalApprovedTestCase;
  backend: PlainPublisher; siteUrl?: string;
}): Promise<{ remoteId: string; remoteUrl: string; created: boolean }> {
  const params = { workspaceId: input.workspaceId, projectId: input.projectId, localType: "test_case", localId: input.testCase.localId };
  const authorized = await sqlGet<{ provider_project_id: string }>(
    `SELECT p.provider_project_id
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @userId AND wm.status = 'active'
     JOIN jira_artifact_backend_configs c ON c.workspace_id = p.workspace_id AND c.project_id = p.id
       AND c.backend_type = 'plain_jira' AND c.status = 'active'
     WHERE p.id = @projectId AND p.workspace_id = @workspaceId
       AND p.provider_id = 'jira-cloud' AND p.status = 'active'`,
    { ...params, userId: input.actorUserId },
  );
  if (!authorized?.provider_project_id) throw new Error("Plain Jira publishing is not authorized for this workspace project.");
  const existing = await sqlGet<LinkRow>(
    `SELECT remote_artifact_id, remote_url FROM jira_artifact_links
     WHERE workspace_id = @workspaceId AND project_id = @projectId
       AND local_artifact_type = @localType AND local_artifact_id = @localId AND status = 'active'`, params,
  );
  if (existing) return { remoteId: existing.remote_artifact_id, remoteUrl: existing.remote_url, created: false };
  const now = nowIso();
  const staleCutoff = new Date(Date.parse(now) - 10 * 60 * 1000).toISOString();
  const claim = await sqlGet<{ id: string }>(
    `INSERT INTO jira_artifact_links (
       id, workspace_id, project_id, backend_type, local_artifact_type, local_artifact_id,
       remote_artifact_id, remote_url, status, created_at, updated_at
     )
     SELECT @id, p.workspace_id, p.id, 'plain_jira', @localType, @localId,
            NULL, NULL, 'publishing', @now, @now
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @userId AND wm.status = 'active'
     WHERE p.id = @projectId AND p.workspace_id = @workspaceId AND p.provider_id = 'jira-cloud' AND p.status = 'active'
     ON CONFLICT (workspace_id, project_id, local_artifact_type, local_artifact_id)
     DO UPDATE SET updated_at = excluded.updated_at
       WHERE jira_artifact_links.status = 'publishing' AND jira_artifact_links.updated_at < @staleCutoff
     RETURNING id`,
    { ...params, id: createId("jiraartifact"), userId: input.actorUserId, now, staleCutoff },
  );
  if (!claim) throw new Error("This iTestFlow artifact is already being published.");
  const published = await input.backend.createTestCase({ projectId: authorized.provider_project_id, testCase: input.testCase });
  if (!published.success || !published.azureTestCaseId) throw new Error("Plain Jira test-case publishing failed.");
  const remoteId = published.azureTestCaseId;
  const remoteUrl = `${(input.siteUrl ?? "").replace(/\/+$/, "")}/browse/${encodeURIComponent(remoteId)}`;
  const linked = await sqlGet<LinkRow>(
    `UPDATE jira_artifact_links SET remote_artifact_id = @remoteId, remote_url = @remoteUrl,
       status = 'active', updated_at = @now
     WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId AND status = 'publishing'
     RETURNING remote_artifact_id, remote_url`,
    { ...params, id: claim.id, remoteId, remoteUrl, now },
  );
  if (!linked) throw new Error("The Jira artifact link is not authorized for this workspace project.");
  return { remoteId: linked.remote_artifact_id, remoteUrl: linked.remote_url, created: true };
}
