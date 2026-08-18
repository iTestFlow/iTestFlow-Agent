import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { LocalFilesystemStorageBackend } from "@/modules/documents/storage/local-filesystem-backend";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { getExecutionArtifact } from "@/modules/test-execution/execution-artifact.service";

const SAFE_ARTIFACT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/zip", "text/plain", "application/json"]);

const ARTIFACT_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "application/json": ".json",
};

function safeArtifactContentType(value: string): string {
  return SAFE_ARTIFACT_TYPES.has(value.toLowerCase().split(";", 1)[0]!) ? value : "application/octet-stream";
}

function artifactFileExtension(value: string): string {
  return ARTIFACT_EXTENSIONS[value.toLowerCase().split(";", 1)[0]!] ?? ".bin";
}

export async function GET(request: Request, context: { params: Promise<{ artifactId: string }> }) {
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
    const ctx = await requireWorkflowContext(workspaceId);
    const projectId = url.searchParams.get("projectId");
    const azureProjectId = url.searchParams.get("azureProjectId");
    const azureProjectName = url.searchParams.get("azureProjectName");
    const azureOrganizationUrl = url.searchParams.get("azureOrganizationUrl");
    if (!projectId || !azureProjectId || !azureProjectName || !azureOrganizationUrl) return NextResponse.json({ error: "Selected project is required." }, { status: 400 });
    const scope = await resolveProjectScope(ctx, { projectId, azureProjectId, azureProjectName, azureOrganizationUrl, workspaceId });
    const { artifactId } = await context.params;
    const artifact = await getExecutionArtifact(artifactId, ctx.workspace.id, scope.projectId);
    if (!artifact) return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    const stream = await new LocalFilesystemStorageBackend().getStream({ storageKey: artifact.storage_key });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": safeArtifactContentType(artifact.mime_type),
        "Content-Length": String(artifact.byte_size),
        "Content-Disposition": `attachment; filename="execution-artifact-${artifactId}${artifactFileExtension(artifact.mime_type)}"`,
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "Artifact could not be loaded." }, { status: 503 });
  }
}
