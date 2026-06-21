import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { fetchProjectScopedLinkedTestCases } from "@/modules/integrations/azure-devops/azure-devops-linked-test-cases.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  userStoryId: z.string().trim().min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Selected project and user story are required." },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const adapter = await getUserAzureAdapter(ctx, parsed.data.scope);
    const linkedTestCases = await fetchProjectScopedLinkedTestCases(adapter, parsed.data.scope, {
      userStoryId: parsed.data.userStoryId,
    });
    return NextResponse.json({ linkedTestCases });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Linked test case fetch failed." },
      { status: 503 },
    );
  }
}
