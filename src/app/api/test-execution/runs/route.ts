import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  getUserAzureAdapter,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  isTestExecutionUnavailableError,
  TEST_EXECUTION_UNAVAILABLE_MESSAGE,
} from "@/modules/jobs/test-execution-jobs.service";
import { getEnvironmentProfile } from "@/modules/test-execution/environment-profile.service";
import {
  ActiveRunConflictError,
  createRunWithSnapshots,
  findActiveRun,
  listRuns,
  profileToEnvConfig,
  RunPlanValidationError,
} from "@/modules/test-execution/run.service";
import { RunCreateSchema } from "@/modules/test-execution/schemas/test-execution.schemas";
import { startWorkflowRun } from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsedScope = ProjectScopeSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedScope.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsedScope.data.workspaceId);
    const scope = await resolveProjectScope(ctx, parsedScope.data);
    const limitParam = Number(url.searchParams.get("limit") ?? "20");
    const runs = await listRuns({ workspaceId: ctx.workspace.id, scope, limit: limitParam });
    const activeRun = await findActiveRun({ workspaceId: ctx.workspace.id, scope });
    return NextResponse.json({ runs, activeRun });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Test execution runs could not be loaded." });
  }
}

const CreateSchema = z.object({ scope: ProjectScopeSchema }).merge(RunCreateSchema);

export async function POST(request: Request) {
  const rate = await checkRateLimit(`test-execution-run-create:${clientIp(request)}`, 10, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many run requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  const parsed = CreateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "The run request is not valid." },
      { status: 400 },
    );
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, scope);

    // Resolve the environment selection into the frozen run config.
    let environment: Parameters<typeof createRunWithSnapshots>[0]["environment"];
    if (parsed.data.environment.mode === "profile") {
      const profile = await getEnvironmentProfile({
        workspaceId: ctx.workspace.id,
        scope,
        environmentProfileId: parsed.data.environment.environmentProfileId,
      });
      if (!profile || profile.lifecycleStatus !== "active") {
        return NextResponse.json({ error: "The selected environment profile was not found." }, { status: 404 });
      }
      environment = { profileId: profile.id, config: profileToEnvConfig(profile), oneTimeSecrets: [] };
    } else {
      environment = {
        profileId: null,
        config: {
          ...parsed.data.environment.config,
          loginPlan: parsed.data.environment.config.loginPlan ?? null,
        },
        oneTimeSecrets: parsed.data.environment.secrets,
      };
    }

    const analyticsRunId = startWorkflowRun({
      scope,
      workflowType: "test_execution",
      workItemId: parsed.data.story?.workItemId,
      userId: ctx.userId,
    });
    const created = await createRunWithSnapshots({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      adapter,
      environment,
      story: parsed.data.story,
      cases: parsed.data.cases,
    });
    return NextResponse.json({ ...created, analyticsRunId }, { status: 202 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof RunPlanValidationError) {
      return NextResponse.json(
        { error: "The execution plan is not valid for this environment.", findings: error.findings },
        { status: 422 },
      );
    }
    if (error instanceof ActiveRunConflictError) {
      return NextResponse.json(
        {
          error: "Another run is already queued or running for this project.",
          activeRunId: error.activeRunId,
        },
        { status: 409 },
      );
    }
    if (isTestExecutionUnavailableError(error)) {
      return NextResponse.json(
        { error: TEST_EXECUTION_UNAVAILABLE_MESSAGE },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }
    return routeErrorResponse(error, { fallback: "The test execution run could not be created." });
  }
}
