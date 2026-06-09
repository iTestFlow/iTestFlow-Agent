import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import type { TestSuite } from "@/modules/integrations/azure-devops/azure-devops-types";
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
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const suiteTree = await adapter.fetchTestSuiteTree({
      projectId: parsed.data.scope.azureProjectId,
      testPlanId: parsed.data.testPlanId,
    });
    const testSuites = flattenSuites(suiteTree);
    return NextResponse.json(
      { testSuites },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure Test Suite fetch failed." },
      { status: 503 },
    );
  }
}

function flattenSuites(
  suites: TestSuite[],
  parentPath = "",
): Array<Omit<TestSuite, "children"> & { path: string }> {
  return suites.flatMap((suite) => {
    const path = parentPath ? `${parentPath} / ${suite.name}` : suite.name;
    const { children = [], ...flatSuite } = suite;
    return [
      { ...flatSuite, path },
      ...flattenSuites(children, path),
    ];
  });
}
