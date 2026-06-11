import { NextResponse } from "next/server";
import { z } from "zod";

import { getActivityLog } from "@/modules/activity-log/activity-log.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema.optional().nullable(),
  search: z.string().max(200).optional(),
  groups: z.array(z.string().max(64)).max(40).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "Activity log request is invalid." }, { status: 400 });
  }

  try {
    return NextResponse.json(
      getActivityLog({
        scope: parsed.data.scope ?? undefined,
        search: parsed.data.search,
        groups: parsed.data.groups,
        from: parsed.data.from,
        to: parsed.data.to,
        limit: parsed.data.limit,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Activity log failed to load." },
      { status: 503 },
    );
  }
}
