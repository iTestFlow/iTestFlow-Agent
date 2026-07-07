import { NextResponse } from "next/server";
import {
  authErrorResponse,
  getUserAzureAdapterOrgLevel,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

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
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Azure DevOps profile fetch failed." });
  }
}
