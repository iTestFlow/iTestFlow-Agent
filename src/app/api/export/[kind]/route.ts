import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const ParamsSchema = z.object({
  kind: z.enum(["requirement-analysis", "test-cases", "coverage", "full-result", "publish-summary"]),
});

export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return NextResponse.json({ error: "Unsupported export kind." }, { status: 400 });

  return NextResponse.json({
    kind: params.data.kind,
    exportedAt: new Date().toISOString(),
    message:
      "No demo export payload is generated. Export a completed live run from the UI or call workflow APIs and export the returned result.",
    payload: null,
  });
}
