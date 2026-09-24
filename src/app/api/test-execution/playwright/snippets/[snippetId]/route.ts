import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { deleteExecutionSnippet, updateExecutionSnippet } from "@/modules/test-execution/execution-snippets.service";

export const runtime = "nodejs";

const Schema = z.object({
  scope: ProjectScopeSchema,
  action: z.enum(["update", "delete"]),
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(4000).optional(),
  expectedResult: z.string().trim().max(4000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ snippetId: string }> }) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide valid snippet details." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { snippetId } = await context.params;
    if (parsed.data.action === "delete") {
      const deleted = await deleteExecutionSnippet(snippetId, ctx.workspace.id, scope.projectId);
      return deleted ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: "Snippet not found." }, { status: 404 });
    }
    if (!parsed.data.name || !parsed.data.instructions) return NextResponse.json({ error: "Snippet name and instructions are required." }, { status: 400 });
    const snippet = await updateExecutionSnippet(snippetId, { workspaceId: ctx.workspace.id, projectId: scope.projectId, userId: ctx.userId,
      name: parsed.data.name, instructions: parsed.data.instructions, expectedResult: parsed.data.expectedResult ?? "" });
    return snippet ? NextResponse.json({ snippet }) : NextResponse.json({ error: "Snippet not found." }, { status: 404 });
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "A snippet with this name already exists." }, { status: 409 });
    }
    return authErrorResponse(error) ?? NextResponse.json({ error: "Snippet could not be changed." }, { status: 503 });
  }
}
