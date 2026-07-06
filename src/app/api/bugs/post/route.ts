import { NextResponse } from "next/server";
import { z } from "zod";
import { postBugReportToAzureDevOps } from "@/modules/bug-reporting/bug-posting.service";
import { FinalBugReportSchema } from "@/modules/bug-reporting/schemas/bug-report.schema";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  completeWorkflowRun,
  failWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const PayloadSchema = z.object({
  scope: ProjectScopeSchema,
  report: FinalBugReportSchema,
  parentStoryId: z.string().trim().optional(),
  assignedTo: z.string().trim().optional(),
  areaPath: z.string().trim().optional(),
  iterationPath: z.string().trim().optional(),
  analyticsRunId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  let analyticsContext: { scope: ProjectScope; runId: string } | undefined;
  try {
    const formData = await request.formData();
    const payloadRaw = formData.get("payload");
    if (typeof payloadRaw !== "string") {
      return NextResponse.json({ error: "Bug post payload is required." }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      return NextResponse.json({ error: "Bug report details are invalid." }, { status: 400 });
    }
    const parsed = PayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bug report details are invalid." }, { status: 400 });
    }

    const attachments = await Promise.all(
      formData
        .getAll("attachments")
        .filter((value): value is File => value instanceof File && value.size > 0)
        .map(async (file) => ({
          fileName: file.name,
          contentType: file.type || undefined,
          content: await file.arrayBuffer(),
        })),
    );

    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    // Establish the analytics context only after the project scope is trusted.
    if (parsed.data.analyticsRunId) {
      analyticsContext = { scope: trustedScope, runId: parsed.data.analyticsRunId };
    }
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const result = await postBugReportToAzureDevOps({
      adapter,
      scope: trustedScope,
      actor: ctx.userId,
      report: parsed.data.report,
      parentStoryId: parsed.data.parentStoryId,
      assignedTo: parsed.data.assignedTo,
      areaPath: parsed.data.areaPath,
      iterationPath: parsed.data.iterationPath,
      attachments,
    });
    if (analyticsContext) {
      completeWorkflowRun({
        scope: analyticsContext.scope,
        runId: analyticsContext.runId,
        status: "published",
        valueRealized: true,
        patch: {
          itemsSelected: 1,
          itemsPublished: 1,
          manualActionsAvoided: 1 + result.attachmentResults.filter((attachment) => attachment.success).length,
        },
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (analyticsContext) {
      failWorkflowRun({
        scope: analyticsContext.scope,
        runId: analyticsContext.runId,
        error: error instanceof Error ? error.message : "Azure DevOps bug creation failed.",
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps bug creation failed." },
      { status: 503 },
    );
  }
}
