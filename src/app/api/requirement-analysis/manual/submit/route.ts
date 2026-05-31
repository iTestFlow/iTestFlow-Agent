import { NextResponse } from "next/server";
import { z } from "zod";
import { completeManualRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  enabledChecklistItemIds: z
    .array(z.enum(requirementAnalysisChecklistItemIdValues))
    .min(1, "Select at least one requirement analysis checklist item."),
  rawOutput: z.string().min(1),
  resolvedContextUsed: z.unknown().optional(),
  retrievalTopK: z.number().int().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    const checklistError = parsed.error.issues.find((issue) => issue.path[0] === "enabledChecklistItemIds");
    const rawOutputError = parsed.error.issues.find((issue) => issue.path[0] === "rawOutput");
    return NextResponse.json(
      { error: checklistError?.message ?? rawOutputError?.message ?? "Paste the external LLM response before continuing." },
      { status: 400 },
    );
  }

  try {
    const result = completeManualRequirementAnalysis({
      scope: parsed.data.scope,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.targetWorkItemId,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: parsed.data.resolvedContextUsed ?? [],
      retrievalTopK: parsed.data.retrievalTopK ?? null,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM requirement analysis validation failed." },
      { status: 422 },
    );
  }
}
