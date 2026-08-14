import "server-only";

import type { PoolClient } from "pg";
import { nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";

const CLAIM_LEASE_MS = 10 * 60 * 1000;

type ProjectLockInput = { workspaceId: string; projectId: string };
type ConfigurationLockInput = ProjectLockInput & { actorUserId: string };
export type JiraArtifactProjectLock = { client: PoolClient; now: string; staleCutoff: string };

export class JiraArtifactPublishInProgressError extends Error {
  constructor() {
    super("A Jira artifact publish is active for this project.");
    this.name = "JiraArtifactPublishInProgressError";
  }
}

export async function withJiraArtifactProjectLock<T>(
  input: ProjectLockInput,
  work: (lock: JiraArtifactProjectLock) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    const lockKey = `${input.workspaceId.length}:${input.workspaceId}:${input.projectId}`;
    await sqlRun(
      `SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 0))`,
      { lockKey },
      client,
    );
    const now = nowIso();
    const staleCutoff = new Date(Date.parse(now) - CLAIM_LEASE_MS).toISOString();
    return work({ client, now, staleCutoff });
  });
}

export async function retireStaleJiraArtifactClaims(
  input: ProjectLockInput,
  lock: JiraArtifactProjectLock,
): Promise<void> {
  await sqlRun(
    `UPDATE jira_artifact_links
     SET status = 'error', updated_at = @now
     WHERE workspace_id = @workspaceId AND project_id = @projectId
       AND status = 'publishing' AND updated_at < @staleCutoff`,
    { ...input, now: lock.now, staleCutoff: lock.staleCutoff },
    lock.client,
  );
}

export async function withAuthorizedJiraArtifactConfigurationLock<T>(
  input: ConfigurationLockInput,
  work: (lock: JiraArtifactProjectLock) => Promise<T>,
): Promise<T> {
  return withJiraArtifactProjectLock(input, async (lock) => {
    const authorized = await sqlGet<{ id: string }>(
      `SELECT p.id
       FROM projects p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @actorUserId
         AND wm.status = 'active' AND wm.role IN ('owner', 'admin')
       WHERE p.workspace_id = @workspaceId AND p.id = @projectId
         AND p.provider_id = 'jira-cloud' AND p.status = 'active'`,
      input,
      lock.client,
    );
    if (!authorized) throw new Error("Jira artifact configuration is not authorized for this project.");
    await retireStaleJiraArtifactClaims(input, lock);
    const liveClaim = await sqlGet<{ id: string }>(
      `SELECT id FROM jira_artifact_links
       WHERE workspace_id = @workspaceId AND project_id = @projectId AND status = 'publishing'
       LIMIT 1`,
      input,
      lock.client,
    );
    if (liveClaim) throw new JiraArtifactPublishInProgressError();
    return work(lock);
  });
}
