import { NextResponse } from "next/server";
import { z } from "zod";
import { completeManualTestCaseGeneration } from "@/modules/test-case-design/application/test-case-generation.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  rawOutput: z.string().min(1),
  resolvedContextUsed: z.unknown().optional(),
  retrievalTopK: z.number().int().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the external LLM response before continuing." }, { status: 400 });
  }

  try {
    const result = completeManualTestCaseGeneration({
      scope: parsed.data.scope,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.targetWorkItemId,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: parsed.data.resolvedContextUsed ?? [],
      retrievalTopK: parsed.data.retrievalTopK ?? null,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM test case validation failed." },
      { status: 422 },
    );
  }
}
