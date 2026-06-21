import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getProjectKnowledgeLog } from "@/modules/rag/project-knowledge-compiled.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before loading the knowledge log." }, { status: 400 });
  }

  try {
    return NextResponse.json({
      items: await getProjectKnowledgeLog({
        scope: parsed.data.scope,
        limit: parsed.data.limit,
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project knowledge log failed." },
      { status: 503 },
    );
  }
}
