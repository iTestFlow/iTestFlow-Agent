import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before running this action." }, { status: 400 });
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const testPlans = await adapter.fetchTestPlans({ projectId: parsed.data.scope.azureProjectId });
    return NextResponse.json({ testPlans });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure Test Plan fetch failed." },
      { status: 503 },
    );
  }
}
