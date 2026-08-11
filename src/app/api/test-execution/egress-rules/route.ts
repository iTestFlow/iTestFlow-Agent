import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  createWorkspaceEgressRule,
  listWorkspaceEgressRules,
  TestExecutionEgressError,
} from "@/modules/test-execution/egress-policy.service";
import { WorkspaceEgressRuleInputSchema } from "@/modules/test-execution/schemas/test-execution.schemas";

export const runtime = "nodejs";

const CreateSchema = z.object({
  workspaceId: z.string().trim().min(1),
  rule: WorkspaceEgressRuleInputSchema,
});

async function requireEgressAdmin(workspaceId: string) {
  const ctx = await requireWorkflowContext(workspaceId);
  await requireWorkflowRole(
    ctx,
    ["owner", "admin"],
    "Only workspace owners and admins can manage test-execution egress rules.",
  );
  return ctx;
}

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim() ?? "";
  if (!workspaceId) return NextResponse.json({ error: "Select a workspace first." }, { status: 400 });
  try {
    const ctx = await requireEgressAdmin(workspaceId);
    const rules = await listWorkspaceEgressRules(ctx.workspace.id);
    return NextResponse.json({ rules }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Egress rules could not be loaded." });
  }
}

export async function POST(request: Request) {
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "The egress rule is not valid." },
      { status: 400 },
    );
  }
  try {
    const ctx = await requireEgressAdmin(parsed.data.workspaceId);
    const rule = await createWorkspaceEgressRule({
      workspaceId: ctx.workspace.id,
      actor: ctx.userId,
      rule: parsed.data.rule,
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof TestExecutionEgressError) {
      return routeErrorResponse(error, { fallback: error.message, status: error.status });
    }
    return routeErrorResponse(error, { fallback: "The egress rule could not be created." });
  }
}
