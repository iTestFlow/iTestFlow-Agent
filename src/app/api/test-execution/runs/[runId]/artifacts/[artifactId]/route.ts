import { NextResponse } from "next/server";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { StorageObjectNotFoundError } from "@/modules/documents/storage/storage-backend.port";
import { getExecutionArtifactStorageBackend } from "@/modules/test-execution/artifact-storage.service";
import { sqlGet } from "@/modules/shared/infrastructure/database/db";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ runId: string; artifactId: string }> };

/**
 * Authorized evidence download. The artifact row is looked up under the
 * trusted workspace/project scope; storage keys never leave the server, and
 * storage-level failures are masked as a plain 404.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const parsedScope = ProjectScopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsedScope.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsedScope.data.workspaceId);
    const scope = await resolveProjectScope(ctx, parsedScope.data);
    const { runId, artifactId } = await params;

    const artifact = await sqlGet<{
      storage_key: string;
      mime_type: string;
      byte_size: number;
      file_name: string;
    }>(
      `SELECT storage_key, mime_type, byte_size, file_name FROM test_execution_artifacts
       WHERE id = @artifactId AND run_id = @runId
         AND workspace_id = @workspaceId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
      {
        artifactId,
        runId,
        workspaceId: ctx.workspace.id,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
      },
    );
    if (!artifact) {
      return NextResponse.json({ error: "The artifact was not found." }, { status: 404 });
    }

    const stream = await getExecutionArtifactStorageBackend().getStream({ storageKey: artifact.storage_key });
    const safeName = artifact.file_name.replace(/[^\w.\-]+/g, "_") || "artifact";
    return new NextResponse(stream as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": artifact.mime_type || "application/octet-stream",
        "Content-Length": String(artifact.byte_size),
        "Content-Disposition": `inline; filename="${safeName}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof StorageObjectNotFoundError) {
      return NextResponse.json({ error: "The artifact was not found." }, { status: 404 });
    }
    return NextResponse.json({ error: "The artifact could not be loaded." }, { status: 500 });
  }
}
