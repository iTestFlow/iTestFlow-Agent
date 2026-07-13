import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import {
  listProjectKnowledgeBenchmarkCases,
  submitProjectKnowledgeBenchmarkQuestion,
} from "@/modules/rag/project-knowledge-benchmark.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  limit: z.number().int().positive().max(500).optional(),
});
const SubmitRequestSchema = z.object({
  scope: ProjectScopeSchema,
  question: z.string().trim().min(12).max(2000).refine((value) => value.split(/\s+/).length >= 3),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json({
      cases: await listProjectKnowledgeBenchmarkCases({ scope, limit: parsed.data.limit }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Project knowledge benchmark could not be loaded." });
  }
}

export async function PUT(request: Request) {
  const parsed = SubmitRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A meaningful benchmark question is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json({
      benchmark: await submitProjectKnowledgeBenchmarkQuestion({ scope, question: parsed.data.question }),
    }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The benchmark question could not be submitted." });
  }
}
