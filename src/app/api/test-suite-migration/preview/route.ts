import { NextResponse } from "next/server";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { SuiteMigrationRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { buildMigrationPreview } from "@/modules/test-suite-migration/test-suite-migration.service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteMigrationRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Migration request is invalid." }, { status: 400 });
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const preview = await buildMigrationPreview(adapter, parsed.data);
    return NextResponse.json({ preview });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Migration preview failed." },
      { status: 503 },
    );
  }
}

function sanitizeAzureError(value: string) {
  return value
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{20,}/g, "Basic [redacted]")
    .replace(/personalAccessToken["'\s:=]+[^"',\s}]+/gi, "personalAccessToken: [redacted]")
    .replace(/pat["'\s:=]+[^"',\s}]+/gi, "PAT: [redacted]");
}
