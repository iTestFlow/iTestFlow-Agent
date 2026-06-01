import { NextResponse } from "next/server";
import { z } from "zod";
import { completeManualBugReport } from "@/modules/bug-reporting/bug-reporting.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  rawOutput: z.string().min(1),
  parentStoryId: z.string().trim().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the external LLM response before continuing." }, { status: 400 });
  }

  try {
    const result = completeManualBugReport({
      scope: parsed.data.scope,
      rawOutput: parsed.data.rawOutput,
      parentStoryId: parsed.data.parentStoryId,
    });

    return NextResponse.json({
      parentStoryId: parsed.data.parentStoryId ?? null,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM bug response validation failed." },
      { status: 422 },
    );
  }
}
