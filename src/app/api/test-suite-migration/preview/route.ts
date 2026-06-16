import { NextResponse } from "next/server";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { SuiteMigrationRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { buildMigrationPreview } from "@/modules/test-suite-migration/test-suite-migration.service";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteMigrationRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Migration request is invalid." }, { status: 400 });
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const preview = await buildMigrationPreview(adapter, parsed.data);
    return NextResponse.json({ preview });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Migration preview failed." },
      { status: 503 },
    );
  }
}
