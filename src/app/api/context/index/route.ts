import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  workItemTypes: z.array(z.string().min(1)).min(1),
  states: z.array(z.string().min(1)).min(1),
  mode: z.enum(["incremental", "rebuild"]).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please select a project, at least one work item type, and at least one state before indexing context." },
      { status: 400 },
    );
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const result = await indexAzureWorkItemsAsProjectContext({
      scope: parsed.data.scope,
      adapter,
      workItemTypes: parsed.data.workItemTypes,
      states: parsed.data.states,
      mode: parsed.data.mode ?? "incremental",
    });

    return NextResponse.json({ source: "live", ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project context indexing failed." },
      { status: 503 },
    );
  }
}
