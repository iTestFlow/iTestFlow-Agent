import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { buildProjectKnowledgeManualDraft } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before preparing the knowledge prompt." }, { status: 400 });
  }

  try {
    return NextResponse.json(buildProjectKnowledgeManualDraft({ scope: parsed.data.scope }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM knowledge prompt preparation failed." },
      { status: 503 },
    );
  }
}
