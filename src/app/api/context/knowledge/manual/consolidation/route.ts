import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { ProjectKnowledgeBaseSchema } from "@/modules/rag/project-knowledge.schema";
import { buildProjectKnowledgeManualConsolidationPrompt } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  partialKnowledgeBases: z.array(ProjectKnowledgeBaseSchema).min(2),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Validate at least two batch responses before preparing consolidation." }, { status: 400 });
  }

  try {
    return NextResponse.json(buildProjectKnowledgeManualConsolidationPrompt({
      scope: parsed.data.scope,
      partialKnowledgeBases: parsed.data.partialKnowledgeBases,
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM knowledge consolidation prompt preparation failed." },
      { status: 503 },
    );
  }
}
