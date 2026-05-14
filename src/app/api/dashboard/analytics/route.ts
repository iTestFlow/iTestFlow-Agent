import { NextResponse } from "next/server";
import { z } from "zod";

import { getDashboardAnalytics } from "@/modules/dashboard/dashboard-analytics.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema.optional().nullable(),
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
    return NextResponse.json({ error: "Dashboard analytics request is invalid." }, { status: 400 });
  }

  try {
    return NextResponse.json(getDashboardAnalytics({ scope: parsed.data.scope ?? undefined }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dashboard analytics failed." },
      { status: 503 },
    );
  }
}
