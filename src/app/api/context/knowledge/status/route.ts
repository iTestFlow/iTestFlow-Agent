import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getProjectKnowledgeBaseSnapshot } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before loading the knowledge base." }, { status: 400 });
  }

  try {
    return NextResponse.json({
      snapshot: await getProjectKnowledgeBaseSnapshot({ scope: parsed.data.scope }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project knowledge status failed." },
      { status: 503 },
    );
  }
}
