import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { ProjectKnowledgeBaseSchema } from "@/modules/rag/project-knowledge.schema";
import { saveManualProjectKnowledgeBaseFromBatches } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  partialKnowledgeBases: z.array(ProjectKnowledgeBaseSchema).min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Validate all batch responses before saving the knowledge base." }, { status: 400 });
  }

  try {
    const snapshot = saveManualProjectKnowledgeBaseFromBatches({
      scope: parsed.data.scope,
      partialKnowledgeBases: parsed.data.partialKnowledgeBases,
    });
    return NextResponse.json({ knowledgeBase: snapshot.knowledgeBase, snapshot });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM knowledge base finalization failed." },
      { status: 422 },
    );
  }
}
