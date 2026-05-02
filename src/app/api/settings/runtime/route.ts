import { NextResponse } from "next/server";
import { getRuntimeSettingsSummary, saveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { RuntimeSettingsInputSchema } from "@/modules/settings/runtime-settings.schema";
import { zodErrorResponse } from "@/shared/validators/api-validation-errors";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getRuntimeSettingsSummary());
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
  return NextResponse.json(summary);
}
