import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  iterationPath: z.string().trim().min(1, "Select an iteration before loading user stories."),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Selected project and iteration are required." }, { status: 400 });
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const stories = await adapter.fetchWorkItems({
      projectId: parsed.data.scope.azureProjectId,
      workItemTypes: ["User Story"],
      iterationPath: parsed.data.iterationPath,
    });
    return NextResponse.json({ stories });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps user story fetch failed." },
      { status: 503 },
    );
  }
}
