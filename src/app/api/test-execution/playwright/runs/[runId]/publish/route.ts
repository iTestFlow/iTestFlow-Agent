import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { beginExecutionPublication, beginFailedExecutionPublicationRetry, finishExecutionPublication, getExecutionRun, publishableCases, recordExecutionPublicationResult } from "@/modules/test-execution/execution-store.service";
import { mapExecutionOutcomeToAzure } from "@/modules/test-execution/playwright-agent";

const Schema = z.object({ scope: ProjectScopeSchema, confirmedReviewed: z.literal(true), retryFailed: z.boolean().optional() });

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selected project is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { runId } = await context.params;
    const run = await getExecutionRun(runId, ctx.workspace.id, scope.projectId);
    if (!run) return NextResponse.json({ error: "Execution run not found." }, { status: 404 });
    if (["queued", "running"].includes(run.status)) return NextResponse.json({ error: "Review results after execution completes before publishing." }, { status: 409 });
    let cases = await publishableCases(runId);
    if (!cases.length) return NextResponse.json({ error: "This execution has no terminal Test Point results to publish. Only cases imported from a Test Plan carry a Test Point." }, { status: 409 });
    const azure = await getUserAzureAdapter(ctx, scope);
    const retry = parsed.data.retryFailed ? await beginFailedExecutionPublicationRetry(runId) : null;
    const priorResults = retry?.prior ?? [];
    if (parsed.data.retryFailed) {
      const successfulPointIds = new Set(priorResults.filter((result) => result.success).map((result) => result.testPointId));
      cases = cases.filter((testCase) => !successfulPointIds.has(testCase.azureTestPointId));
      if (!cases.length) {
        if (retry) await finishExecutionPublication({ id: retry.id, leaseToken: retry.leaseToken, status: "completed", result: priorResults });
        return NextResponse.json({ error: "There are no failed Test Point publications to retry." }, { status: 409 });
      }
    }
    const publication = retry ?? await beginExecutionPublication(runId, ctx.userId);
    if (!publication) return NextResponse.json({ error: "These execution results were already published or publication is in progress." }, { status: 409 });
    const results = priorResults.filter((result) => result.success);
    try {
      for (const testCase of cases) {
        const result = await azure.updateTestPoints({
          projectId: scope.azureProjectId, testPlanId: String(testCase.azurePlanId), testSuiteId: String(testCase.azureSuiteId),
          pointIds: [String(testCase.azureTestPointId)], outcome: mapExecutionOutcomeToAzure(testCase.outcome),
        });
        const receipt = { testCaseId: testCase.azureTestCaseId, testPointId: testCase.azureTestPointId, success: result.success, error: result.error };
        results.push(receipt);
        if (!await recordExecutionPublicationResult(publication.id, publication.leaseToken, receipt)) throw new Error("Publication lease was lost.");
      }
    } catch (error) {
      await finishExecutionPublication({ id: publication.id, leaseToken: publication.leaseToken, status: "failed", result: results });
      throw error;
    }
    const succeeded = results.filter((result) => result.success).length;
    const status = succeeded === results.length ? "completed" : succeeded ? "partial" : "failed";
    await finishExecutionPublication({ id: publication.id, leaseToken: publication.leaseToken, status, result: results });
    return NextResponse.json({ runId, status, published: succeeded, total: results.length, results });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "Execution results could not be published." }, { status: 503 });
  }
}
