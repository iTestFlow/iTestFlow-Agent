import { NextResponse } from "next/server";
import { z } from "zod";
import { findCurrentIterationPath } from "@/modules/bug-reporting/bug-posting.service";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before loading Bug metadata." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext();
    const adapter = await getUserAzureAdapter(ctx, parsed.data.scope);
    const [fields, users, iterations, areas] = await Promise.all([
      adapter.fetchWorkItemTypeFields({ projectId: parsed.data.scope.azureProjectId, workItemType: "Bug" }),
      adapter.fetchProjectUsers({ projectId: parsed.data.scope.azureProjectId }),
      adapter.fetchIterations({ projectId: parsed.data.scope.azureProjectId }),
      adapter.fetchAreas({ projectId: parsed.data.scope.azureProjectId }),
    ]);

    return NextResponse.json({
      fields,
      users,
      iterations,
      areas,
      currentIterationPath: findCurrentIterationPath(iterations) || null,
      defaultAreaPath: areas[0]?.path ?? null,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps Bug metadata fetch failed." },
      { status: 503 },
    );
  }
}
