import { NextResponse } from "next/server";
import { z } from "zod";
import { postBugReportToAzureDevOps } from "@/modules/bug-reporting/bug-posting.service";
import { FinalBugReportSchema } from "@/modules/bug-reporting/schemas/bug-report.schema";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const PayloadSchema = z.object({
  scope: ProjectScopeSchema,
  report: FinalBugReportSchema,
  parentStoryId: z.string().trim().optional(),
  assignedTo: z.string().trim().optional(),
  areaPath: z.string().trim().optional(),
  iterationPath: z.string().trim().optional(),
});

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const payloadRaw = formData.get("payload");
    if (typeof payloadRaw !== "string") {
      return NextResponse.json({ error: "Bug post payload is required." }, { status: 400 });
    }

    const parsed = PayloadSchema.safeParse(JSON.parse(payloadRaw));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bug report details are invalid." }, { status: 400 });
    }

    const attachments = await Promise.all(
      formData
        .getAll("attachments")
        .filter((value): value is File => value instanceof File && value.size > 0)
        .map(async (file) => ({
          fileName: file.name,
          contentType: file.type || undefined,
          content: await file.arrayBuffer(),
        })),
    );

    const adapter = getConfiguredAzureDevOpsAdapter();
    const result = await postBugReportToAzureDevOps({
      adapter,
      scope: parsed.data.scope,
      report: parsed.data.report,
      parentStoryId: parsed.data.parentStoryId,
      assignedTo: parsed.data.assignedTo,
      areaPath: parsed.data.areaPath,
      iterationPath: parsed.data.iterationPath,
      attachments,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps bug creation failed." },
      { status: 503 },
    );
  }
}
