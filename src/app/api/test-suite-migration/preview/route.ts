import { NextResponse } from "next/server";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { SuiteMigrationRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { buildMigrationPreview } from "@/modules/test-suite-migration/test-suite-migration.service";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteMigrationRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Migration request is invalid." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const preview = await buildMigrationPreview(adapter, parsed.data);
    return NextResponse.json({ preview });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Migration preview failed." },
      { status: 503 },
    );
  }
}
