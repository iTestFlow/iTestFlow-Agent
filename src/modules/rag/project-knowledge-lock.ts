import type { PoolClient } from "pg";

import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sqlGet } from "@/modules/shared/infrastructure/database/db";

const PROJECT_KNOWLEDGE_LOCK_NAMESPACE = "itestflow:project-knowledge";

export function projectKnowledgeLockKey(scope: Pick<ProjectScope, "projectId" | "azureProjectId">) {
  return `${PROJECT_KNOWLEDGE_LOCK_NAMESPACE}:${scope.projectId}:${scope.azureProjectId}`;
}

/** Must be the first application statement in a sync/publication transaction. */
export async function acquireProjectKnowledgeLock(
  scope: Pick<ProjectScope, "projectId" | "azureProjectId">,
  client: PoolClient,
) {
  await sqlGet<{ acquired: null }>(
    "SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 0)) AS acquired",
    { lockKey: projectKnowledgeLockKey(scope) },
    client,
  );
}
