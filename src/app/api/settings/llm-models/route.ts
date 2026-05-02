import { NextResponse } from "next/server";
import { z } from "zod";
import { ListLLMModelsInputSchema, listLLMModels } from "@/modules/llm/model-catalog.service";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { LLMProviderNameSchema } from "@/modules/settings/runtime-settings.schema";
import { zodErrorResponse } from "@/shared/validators/api-validation-errors";

export const runtime = "nodejs";

const RequestSchema = z.object({
  provider: LLMProviderNameSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export async function POST(request: Request) {
  const requestBody = RequestSchema.safeParse(await request.json());
  if (!requestBody.success) {
    return NextResponse.json(
      zodErrorResponse("Model list could not be loaded.", requestBody.error),
      { status: 400 },
    );
  }

  const savedSettings = getEffectiveRuntimeSettings();
  const savedProviderSettings = savedSettings?.llm.provider === requestBody.data.provider ? savedSettings.llm : null;
  const apiKey = requestBody.data.apiKey?.trim() || savedProviderSettings?.apiKey;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Model list could not be loaded. Enter the selected provider API token so the app can fetch models from the live provider API.",
        validationErrors: [{
          field: "apiKey",
          label: "LLM API Token",
          message: "Enter the selected provider API token to load models from the live provider API.",
        }],
      },
      { status: 400 },
    );
  }

  const parsed = ListLLMModelsInputSchema.safeParse({
    provider: requestBody.data.provider,
    apiKey,
    baseUrl: requestBody.data.baseUrl?.trim() || savedProviderSettings?.baseUrl,
  });

  if (!parsed.success) {
    return NextResponse.json(
      zodErrorResponse("Model list could not be loaded.", parsed.error),
      { status: 400 },
    );
  }

  try {
    const models = await listLLMModels(parsed.data);
    return NextResponse.json({ models, source: "provider-api" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Live provider API model fetch failed." },
      { status: 503 },
    );
  }
}
