import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { ProjectKnowledgeBaseSchema } from "@/modules/rag/project-knowledge.schema";
import { saveGeneratedProjectKnowledgeBaseDraft } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  rawOutput: z.string().min(1),
  requestedMode: z.enum(["incremental", "full"]).optional(),
  mode: z.enum(["incremental", "full"]),
  knowledgeBase: ProjectKnowledgeBaseSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Preview generated knowledge before saving." }, { status: 400 });
  }

  try {
    return NextResponse.json(await saveGeneratedProjectKnowledgeBaseDraft(parsed.data));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project knowledge save failed." },
      { status: 422 },
    );
  }
}
