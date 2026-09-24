import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { createExecutionSnippet, listExecutionSnippets } from "@/modules/test-execution/execution-snippets.service";

export const runtime = "nodejs";

const Schema = z.object({
  scope: ProjectScopeSchema,
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(4000).optional(),
  expectedResult: z.string().trim().max(4000).optional(),
});

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide a valid project and snippet." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    if (parsed.data.name === undefined) {
      return NextResponse.json({ snippets: await listExecutionSnippets(ctx.workspace.id, scope.projectId) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!parsed.data.instructions) return NextResponse.json({ error: "Snippet instructions are required." }, { status: 400 });
    const snippet = await createExecutionSnippet({ workspaceId: ctx.workspace.id, projectId: scope.projectId, userId: ctx.userId,
      name: parsed.data.name, instructions: parsed.data.instructions, expectedResult: parsed.data.expectedResult ?? "" });
    return snippet ? NextResponse.json({ snippet }, { status: 201 }) : NextResponse.json({ error: "A snippet with this name already exists." }, { status: 409 });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "Snippets could not be saved." }, { status: 503 });
  }
}
