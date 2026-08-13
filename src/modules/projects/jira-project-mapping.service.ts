import "server-only";

import { createId, nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";

export async function upsertJiraProjectMapping(input: {
  workspaceId: string;
  providerId: "jira-cloud";
  jiraProjectId: string;
  jiraProjectKey: string;
  jiraProjectName: string;
}): Promise<string> {
  const now = nowIso();
  const row = await sqlGet<{ id: string }>(
    `INSERT INTO projects (
       id, azure_project_id, azure_project_name, azure_organization_url,
       name, status, workspace_id, provider_id,
       provider_project_id, provider_project_key, provider_project_name, created_at, updated_at
     )
     SELECT @id, @jiraProjectId, @jiraProjectName, w.provider_site_url,
            @jiraProjectName, 'active', w.id, @providerId,
            @jiraProjectId, @jiraProjectKey, @jiraProjectName, @now, @now
     FROM workspaces w
     WHERE w.id = @workspaceId AND w.provider_id = 'jira-cloud' AND w.status = 'active'
     ON CONFLICT (workspace_id, provider_id, provider_project_id) WHERE workspace_id IS NOT NULL AND provider_project_id IS NOT NULL
     DO UPDATE SET
       provider_project_key = excluded.provider_project_key,
       provider_project_name = excluded.provider_project_name,
       azure_project_name = excluded.azure_project_name,
       name = excluded.name,
       status = 'active',
       updated_at = excluded.updated_at
     RETURNING id`,
    {
      id: createId("project"), workspaceId: input.workspaceId, providerId: input.providerId,
      jiraProjectId: input.jiraProjectId.trim(), jiraProjectKey: input.jiraProjectKey.trim(),
      jiraProjectName: input.jiraProjectName.trim(), now,
    },
  );
  if (!row) throw new Error("Jira project mapping is not available for this workspace.");
  return row.id;
}
