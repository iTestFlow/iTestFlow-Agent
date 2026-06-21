import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { buildProjectKnowledgeManualDraft } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional().default("full"),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before preparing the knowledge prompt." }, { status: 400 });
  }

  try {
    return NextResponse.json(await buildProjectKnowledgeManualDraft({
      scope: parsed.data.scope,
      mode: parsed.data.mode,
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM knowledge prompt preparation failed." },
      { status: 503 },
    );
  }
}
