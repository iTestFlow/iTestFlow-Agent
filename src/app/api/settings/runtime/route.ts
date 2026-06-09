import { NextResponse } from "next/server";
import { z } from "zod";
import { getEffectiveRuntimeSettings, getRuntimeSettingsSummary, saveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { RuntimeSettingsInputSchema, type RuntimeSettingsSummary } from "@/modules/settings/runtime-settings.schema";
import { getLatestContextAutoUpdateRun } from "@/modules/rag/context-auto-update-run-history.service";
import { zodErrorResponse } from "@/shared/validators/api-validation-errors";

export const runtime = "nodejs";

const RuntimeSettingsPatchSchema = z.object({
  llm: z.object({
    model: z.string({
      required_error: "Select an LLM model.",
      invalid_type_error: "Select an LLM model.",
    }).trim().min(1, "Select an LLM model."),
  }),
});

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

export async function PATCH(request: Request) {
  const parsed = RuntimeSettingsPatchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      zodErrorResponse("Configuration could not be updated.", parsed.error),
      { status: 400 },
    );
  }

  const settings = getEffectiveRuntimeSettings();
  if (!settings) {
    return NextResponse.json(
      { error: "Runtime settings are not configured. Configure an LLM provider, model, and API key in Settings." },
      { status: 400 },
    );
  }

  const summary = saveRuntimeSettings({
    azureDevOps: settings.azureDevOps,
    llm: {
      ...settings.llm,
      model: parsed.data.llm.model,
    },
    context: settings.context,
  });

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
