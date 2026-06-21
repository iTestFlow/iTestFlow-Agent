import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { runProjectKnowledgeLint } from "@/modules/rag/project-knowledge-compiled.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before running knowledge health checks." }, { status: 400 });
  }

  try {
    return NextResponse.json(await runProjectKnowledgeLint({ scope: parsed.data.scope }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project knowledge lint failed." },
      { status: 503 },
    );
  }
}
