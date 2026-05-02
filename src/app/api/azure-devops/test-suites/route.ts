import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  testPlanId: z.string().min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Selected project and Test Plan ID are required." }, { status: 400 });
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const testSuites = await adapter.fetchTestSuites({
      projectId: parsed.data.scope.azureProjectId,
      testPlanId: parsed.data.testPlanId,
    });
    return NextResponse.json({ testSuites });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure Test Suite fetch failed." },
      { status: 503 },
    );
  }
}
