import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { answerContextChatbot } from "@/modules/context-chatbot/context-chatbot.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(6000),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  message: z.string().trim().min(1).max(4000),
  history: z.array(HistoryMessageSchema).max(20).default([]),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select a project and enter a chat message." },
      { status: 400 },
    );
  }

  let analyticsRunId: string | undefined;
  try {
    const provider = getConfiguredProviderFromEnv();
    if (!provider) {
      return NextResponse.json(
        { error: "No LLM provider configured. Configure a provider, model, and API key in Settings." },
        { status: 503 },
      );
    }
    analyticsRunId = startWorkflowRun({
      scope: parsed.data.scope,
      workflowType: "business_owner_assistant",
    });

    const result = await answerContextChatbot({
      scope: parsed.data.scope,
      provider,
      message: parsed.data.message,
      history: parsed.data.history,
    });
    completeWorkflowRun({
      scope: parsed.data.scope,
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
    writeGenerationFailureAudit({ scope: parsed.data.scope, action: "context_chatbot.answer", label: "Context chatbot failed.", error });
    if (analyticsRunId) {
      failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Context chatbot failed." });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Context chatbot failed." },
      { status: 503 },
    );
  }
}
