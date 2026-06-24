import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import {
  saveManualProjectKnowledgeBaseSnapshot,
  validateProjectKnowledgeExternalOutput,
} from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  rawOutput: z.string().min(1),
  mode: z.enum(["incremental", "full"]).optional().default("full"),
  save: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the external LLM JSON response before continuing." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    if (parsed.data.save) {
      const snapshot = await saveManualProjectKnowledgeBaseSnapshot({
        scope: trustedScope,
        actor: ctx.userId,
        rawOutput: parsed.data.rawOutput,
        mode: parsed.data.mode,
      });
      return NextResponse.json({ knowledgeBase: snapshot.knowledgeBase, snapshot });
    }

    return NextResponse.json({
      knowledgeBase: validateProjectKnowledgeExternalOutput(parsed.data.rawOutput),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM knowledge response validation failed." },
      { status: 422 },
    );
  }
}
