import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { ConnectionSchema } from "@/modules/test-execution/execution-connections.schema";
import { checkExecutionConnection } from "@/modules/test-execution/execution-connections.check";
import { ConnectionResolutionError, prepareConnections } from "@/modules/test-execution/execution-connections.service";

export const runtime = "nodejs";

const Schema = z.object({ scope: ProjectScopeSchema, connection: ConnectionSchema });

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide valid connection details." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const [prepared] = await prepareConnections({ workspaceId: ctx.workspace.id, projectId: scope.projectId,
      connections: [parsed.data.connection] });
    const result = await checkExecutionConnection(prepared);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConnectionResolutionError) return NextResponse.json({ error: error.message }, { status: 422 });
    return authErrorResponse(error) ?? NextResponse.json({ error: "Connection could not be checked." }, { status: 503 });
  }
}
