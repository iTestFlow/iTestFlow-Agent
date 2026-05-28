import { NextResponse } from "next/server";
import { getRuntimeSettingsSummary, saveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { RuntimeSettingsInputSchema, type RuntimeSettingsSummary } from "@/modules/settings/runtime-settings.schema";
import { getLatestContextAutoUpdateRun } from "@/modules/rag/context-auto-update-run-history.service";
import { zodErrorResponse } from "@/shared/validators/api-validation-errors";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(withContextAutoUpdateStatus(getRuntimeSettingsSummary()));
}

export async function POST(request: Request) {
  const parsed = RuntimeSettingsInputSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      zodErrorResponse("Configuration could not be saved.", parsed.error),
      { status: 400 },
    );
  }

  const summary = saveRuntimeSettings(parsed.data);
  return NextResponse.json(withContextAutoUpdateStatus(summary));
}

function withContextAutoUpdateStatus(summary: RuntimeSettingsSummary): RuntimeSettingsSummary {
  if (!summary.context?.autoUpdate) return summary;

  return {
    ...summary,
    context: {
      ...summary.context,
      autoUpdate: {
        ...summary.context.autoUpdate,
        latestRun: getLatestContextAutoUpdateRun(),
      },
    },
  };
}
