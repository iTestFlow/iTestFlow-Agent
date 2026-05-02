import { NextResponse } from "next/server";

import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";

export const runtime = "nodejs";

export async function GET() {
  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const user = await adapter.fetchAuthenticatedUser();
    return NextResponse.json({ mode: "live", user });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Azure DevOps profile fetch failed.",
      },
      { status: 503 },
    );
  }
}
