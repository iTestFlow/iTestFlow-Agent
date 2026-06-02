import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { promoteContextChatbotAnswer } from "@/modules/rag/project-knowledge-compiled.service";

export const runtime = "nodejs";

const CitationSchema = z.object({
  sourceType: z.enum(["project_context", "project_knowledge"]),
  sourceId: z.string().min(1),
  workItemId: z.string().optional(),
  sourceWorkItemIds: z.array(z.string()).optional(),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  answer: z.string().trim().min(1),
  citations: z.array(CitationSchema).min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Promoted knowledge must include a selected project, an answer, and at least one citation." }, { status: 400 });
  }

  try {
    return NextResponse.json(promoteContextChatbotAnswer(parsed.data));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Context chatbot answer promotion failed." },
      { status: 422 },
    );
  }
}
