import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { createExecutionRun } from "@/modules/test-execution/execution-store.service";
import { resolvePlaywrightMcpConfig } from "@/modules/test-execution/playwright-mcp-config.service";
import { selectedSuiteIds } from "@/modules/test-execution/suite-selection";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";

export const runtime = "nodejs";

const Schema = z.object({
  scope: ProjectScopeSchema,
  testPlanId: z.coerce.number().int().positive(),
  testSuiteId: z.coerce.number().int().positive(),
});

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selected project, Test Plan, and Test Suite are required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const config = await resolvePlaywrightMcpConfig(ctx.workspace.id);
    if (!config || config.status !== "configured") {
      return NextResponse.json({ error: "A workspace owner or admin must configure and enable Playwright MCP first." }, { status: 409 });
    }
    if (!await hasHealthyWorkerCapability("playwright_mcp_execution")) {
      return NextResponse.json({ error: "No healthy worker is available for Playwright MCP execution." }, { status: 503 });
    }
    const adapter = await getUserAzureAdapter(ctx, scope);
    const tree = await adapter.fetchTestSuiteTree({ projectId: scope.azureProjectId, testPlanId: String(parsed.data.testPlanId) });
    const suiteIds = selectedSuiteIds(tree, String(parsed.data.testSuiteId));
    const pointGroups = await Promise.all(suiteIds.map((testSuiteId) => adapter.fetchTestPoints({
      projectId: scope.azureProjectId,
      testPlanId: String(parsed.data.testPlanId),
      testSuiteId,
    })));
    const points = pointGroups.flat();
    const testCaseIds = [...new Set(points.map((point) => point.testCaseId).filter((id): id is string => Boolean(id)))];
    const testCases = await adapter.fetchTestCasesByIds({ projectId: scope.azureProjectId, testCaseIds });
    const caseById = new Map(testCases.map((testCase) => [testCase.azureTestCaseId ?? testCase.id, testCase]));
    const seen = new Set<string>();
    const cases = points.flatMap((point) => {
      if (!point.testCaseId || seen.has(point.id)) return [];
      seen.add(point.id);
      const testCase = caseById.get(point.testCaseId);
      if (!testCase) return [];
      return [{
        testCaseId: Number(point.testCaseId),
        testPointId: Number(point.id),
        suiteId: Number(point.suiteId ?? parsed.data.testSuiteId),
        title: testCase.title,
        steps: testCase.steps,
      }];
    });
    if (!cases.length) return NextResponse.json({ error: "No executable test cases were found in the selected suite tree." }, { status: 422 });
    const { runId, jobId } = await createExecutionRun({
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      planId: parsed.data.testPlanId,
      suiteId: parsed.data.testSuiteId,
      requestedByUserId: ctx.userId,
      configSnapshot: { transport: config.transport, endpoint: config.endpoint, artifactBaseUrl: config.artifactBaseUrl },
      job: { userId: ctx.userId, scope },
      cases,
    });
    return NextResponse.json({ runId, jobId, status: "queued", totalCases: cases.length }, { status: 202 });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Playwright MCP execution could not be queued." });
  }
}
