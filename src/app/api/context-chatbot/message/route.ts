import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { answerContextChatbot } from "@/modules/context-chatbot/context-chatbot.service";
import {
  CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT,
  normalizeContextChatbotHistory,
} from "@/modules/context-chatbot/context-chatbot-history";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  message: z.string().trim().min(1).max(4000),
  history: z
    .preprocess(
      (value) => (Array.isArray(value) ? value.slice(-CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT) : value),
      z.array(HistoryMessageSchema),
    )
    .default([])
    .transform((history) => normalizeContextChatbotHistory(history)),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select a project and enter a chat message." },
      { status: 400 },
    );
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "business_owner_assistant",
      userId: ctx.userId,
    });

    const result = await answerContextChatbot({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      message: parsed.data.message,
      history: parsed.data.history,
    });
    completeWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      valueRealized: false,
      patch: {
        itemsGenerated: 1,
        usedKnowledgeContext: result.citations.length > 0,
        metadata: { contextUsed: result.citations.map((citation) => citation.sourceId) },
      },
    });

    return NextResponse.json({ ...result, analyticsRunId });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "context_chatbot.answer", label: "Context chatbot failed.", error });
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Context chatbot failed." });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Context chatbot failed." },
      { status: 503 },
    );
  }
}
