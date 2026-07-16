import "server-only";

import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { getPool, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { findActiveJob } from "./job-queue.service";

const OPERATION_GATE_NAMESPACE = "itestflow:project-knowledge-operation";
const PROJECT_KNOWLEDGE_JOB_TYPE = "project_knowledge_v4";

export async function withProjectKnowledgeOperationGate<T>(
  scope: Pick<ProjectScope, "workspaceId" | "projectId" | "azureProjectId">,
  operation: string,
  action: () => Promise<T>,
) {
  if (!scope.workspaceId) throw new Error("Project knowledge operations require a workspace.");
  const client = await getPool().connect();
  const lockKey = `${OPERATION_GATE_NAMESPACE}:${scope.projectId}:${scope.azureProjectId}`;
  let acquired = false;
  try {
    const row = await sqlGet<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended(@lockKey, 0)) AS acquired",
      { lockKey },
      client,
    );
    acquired = Boolean(row?.acquired);
    if (!acquired) throw activeOperationError(operation);
    return await action();
  } finally {
    if (acquired) {
      try {
        await sqlGet(
          "SELECT pg_advisory_unlock(hashtextextended(@lockKey, 0)) AS released",
          { lockKey },
          client,
        );
      } catch (error) {
        console.error("[knowledge] failed to release the project operation gate", error);
      }
    }
    client.release();
  }
}

export async function assertNoActiveProjectKnowledgeBuild(
  scope: Pick<ProjectScope, "workspaceId" | "projectId">,
) {
  if (!scope.workspaceId) throw new Error("Project knowledge operations require a workspace.");
  const active = await findActiveJob({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    jobType: PROJECT_KNOWLEDGE_JOB_TYPE,
    dedupeKey: `project_knowledge:${scope.projectId}`,
  });
  if (active) throw activeOperationError("build");
}

function activeOperationError(operation: string) {
  return new AppError({
    code: AppErrorCode.KnowledgeDraftConflict,
    message: `A project knowledge operation prevented ${operation}.`,
    userMessage: "Another knowledge operation is active for this project. Wait for it to finish and try again.",
  });
}
