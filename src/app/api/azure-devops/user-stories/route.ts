import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  iterationPath: z.string().trim().min(1, "Select an iteration before loading user stories.").optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A selected project is required." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const stories = await adapter.fetchWorkItems({
      projectId: trustedScope.azureProjectId,
      workItemTypes: ["User Story"],
      iterationPath: parsed.data.iterationPath,
    });
    return NextResponse.json({ stories });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps user story fetch failed." },
      { status: 503 },
    );
  }
}
