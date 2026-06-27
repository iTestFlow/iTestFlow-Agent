import { NextResponse } from "next/server";
import {
  authErrorResponse,
  getUserAzureAdapterOrgLevel,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireWorkflowContext();
    const adapter = await getUserAzureAdapterOrgLevel(ctx);
    const user = await adapter.fetchAuthenticatedUser();
    return NextResponse.json({ mode: "live", user });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Azure DevOps profile fetch failed.",
      },
      { status: 503 },
    );
  }
}
