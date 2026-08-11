import { NextResponse } from "next/server";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { createScrubber } from "@/modules/integrations/browser-automation/output-scrubber";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { assembleRunDetail, assembleRunDetailDelta } from "@/modules/test-execution/report-assembler";
import { loadRunSecretValuesForRedaction } from "@/modules/test-execution/run-persistence.service";
import { loadRunDetailChangeRows, loadRunDetailRows } from "@/modules/test-execution/run.service";
import { buildScrubValuesFromValues } from "@/modules/test-execution/secret-resolution";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const url = new URL(request.url);
  const parsedScope = ProjectScopeSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedScope.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  const afterCursorParam = url.searchParams.get("afterCursor");
  const afterCursor = afterCursorParam && /^\d{1,18}$/.test(afterCursorParam) ? afterCursorParam : null;
  try {
    const ctx = await requireWorkflowContext(parsedScope.data.workspaceId);
    const scope = await resolveProjectScope(ctx, parsedScope.data);
    const { runId } = await params;

    // Incremental poll: only rows whose change_seq moved past the cursor.
    if (afterCursor !== null) {
      const changeRows = await loadRunDetailChangeRows({
        workspaceId: ctx.workspace.id,
        scope,
        runId,
        afterCursor,
      });
      if (!changeRows) {
        return NextResponse.json({ error: "The test execution run was not found." }, { status: 404 });
      }
      const secretValues = await loadRunSecretValuesForRedaction(runId);
      const delta = assembleRunDetailDelta(changeRows, null, {
        scrubText: createScrubber(buildScrubValuesFromValues(secretValues, { minimumLength: 4 })),
        exactValues: new Set(secretValues),
      });
      return NextResponse.json({ delta });
    }

    const rows = await loadRunDetailRows({ workspaceId: ctx.workspace.id, scope, runId });
    // Read-time value redaction from the run's own frozen secrets — the
    // second barrier behind the worker's write-time scrubbing.
    const secretValues = rows ? await loadRunSecretValuesForRedaction(runId) : [];
    const detail = rows
      ? assembleRunDetail(rows, {
          scrubText: createScrubber(buildScrubValuesFromValues(secretValues, { minimumLength: 4 })),
          exactValues: new Set(secretValues),
        })
      : null;
    return detail
      ? NextResponse.json(detail)
      : NextResponse.json({ error: "The test execution run was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The test execution run could not be loaded." });
  }
}
