import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { answerContextChatbot } from "@/modules/context-chatbot/context-chatbot.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

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

  try {
    const provider = getConfiguredProviderFromEnv();
    if (!provider) {
      return NextResponse.json(
        { error: "No LLM provider configured. Configure a provider, model, and API key in Settings." },
        { status: 503 },
      );
    }

    const result = await answerContextChatbot({
      scope: parsed.data.scope,
      provider,
      message: parsed.data.message,
      history: parsed.data.history,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Context chatbot failed." },
      { status: 503 },
    );
  }
}
