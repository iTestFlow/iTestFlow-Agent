import { NextResponse } from "next/server";
import { z } from "zod";
import { syncAzureDevOpsWorkItems } from "@/modules/integrations/azure-devops/azure-devops-sync.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";

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
    const result = await syncAzureDevOpsWorkItems(adapter, parsed.data.scope);
    return NextResponse.json({ mode: "live", ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Azure DevOps sync failed.",
      },
      { status: 503 },
    );
  }
}
