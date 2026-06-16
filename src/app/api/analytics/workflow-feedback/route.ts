import { NextResponse } from "next/server";
import { z } from "zod";

import { recordWorkflowFeedback } from "@/modules/analytics/workflow-analytics.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  runId: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  label: z.enum([
    "accepted_without_edits",
    "accepted_minor_edits",
    "accepted_major_edits",
    "rejected",
  ]).optional(),
  comment: z.string().max(1000).optional(),
}).refine((value) => !(value.label === "rejected" && value.rating >= 2), {
  message: "A 'Rejected' label cannot be combined with a useful rating.",
  path: ["label"],
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Feedback is invalid." }, { status: 400 });
  }

  try {
    const { recorded } = recordWorkflowFeedback(parsed.data);
    if (!recorded) {
      return NextResponse.json(
        { error: "The workflow run for this feedback was not found in the selected project." },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Feedback could not be saved." },
      { status: 503 },
    );
  }
}
