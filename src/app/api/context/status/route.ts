import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getRecentProjectContext } from "@/modules/rag/project-context-store.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  sortBy: z.enum(["lastIndexedAt", "type", "state"]).default("lastIndexedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  query: z.string().optional().default(""),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before loading context status." }, { status: 400 });
  }

  try {
    return NextResponse.json(
      getRecentProjectContext({
        scope: parsed.data.scope,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        sortBy: parsed.data.sortBy,
        sortDirection: parsed.data.sortDirection,
        query: parsed.data.query,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project context status failed." },
      { status: 503 },
    );
  }
}
