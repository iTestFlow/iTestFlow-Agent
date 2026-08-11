import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse } from "@/modules/credentials/scoped-resolution.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  deleteWorkspaceEgressRule,
  TestExecutionEgressError,
  updateWorkspaceEgressRule,
} from "@/modules/test-execution/egress-policy.service";

import { requireEgressAdmin } from "../egress-admin";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ ruleId: string }> };

const UpdateSchema = z.object({
  workspaceId: z.string().trim().min(1),
  changes: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    targetKind: z.enum(["api", "database", "oauth", "openapi"]).optional(),
    protocol: z.enum(["http", "https", "tcp"]).optional(),
    hostPattern: z.string().trim().min(1).max(255).optional(),
    portFrom: z.number().int().min(1).max(65_535).optional(),
    portTo: z.number().int().min(1).max(65_535).optional(),
    allowPrivateNetwork: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }).strict().refine(
    (changes) => Object.keys(changes).length > 0,
    "Provide at least one egress-rule change.",
  ),
});
const DeleteSchema = z.object({ workspaceId: z.string().trim().min(1) });

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "The egress-rule update is not valid." },
      { status: 400 },
    );
  }
  try {
    const ctx = await requireEgressAdmin(parsed.data.workspaceId);
    const { ruleId } = await params;
    const rule = await updateWorkspaceEgressRule({
      workspaceId: ctx.workspace.id,
      actor: ctx.userId,
      ruleId,
      changes: parsed.data.changes,
    });
    return rule
      ? NextResponse.json({ rule })
      : NextResponse.json({ error: "The egress rule was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof TestExecutionEgressError) {
      return routeErrorResponse(error, { fallback: error.message, status: error.status });
    }
    return routeErrorResponse(error, { fallback: "The egress rule could not be updated." });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const parsed = DeleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Select a workspace first." }, { status: 400 });
  try {
    const ctx = await requireEgressAdmin(parsed.data.workspaceId);
    const { ruleId } = await params;
    const deleted = await deleteWorkspaceEgressRule({
      workspaceId: ctx.workspace.id,
      actor: ctx.userId,
      ruleId,
    });
    return deleted
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "The egress rule was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The egress rule could not be deleted." });
  }
}
