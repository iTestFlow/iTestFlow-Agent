import { NextResponse } from "next/server";
import { AzureDevOpsRestAdapter } from "@/modules/integrations/azure-devops/azure-devops-client";
import { createLLMProvider } from "@/modules/llm/llm-provider.factory";
import { RuntimeSettingsInputSchema } from "@/modules/settings/runtime-settings.schema";
import { zodErrorResponse } from "@/shared/validators/api-validation-errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = RuntimeSettingsInputSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      zodErrorResponse("Connection test could not run.", parsed.error),
      { status: 400 },
    );
  }

  const azureAdapter = new AzureDevOpsRestAdapter({
    organizationUrl: parsed.data.azureDevOps.organizationUrl,
    personalAccessToken: parsed.data.azureDevOps.personalAccessToken,
  });
  const llmProvider = createLLMProvider({
    provider: parsed.data.llm.provider,
    apiKey: parsed.data.llm.apiKey,
    model: parsed.data.llm.model,
    baseUrl: parsed.data.llm.baseUrl,
    maxOutputTokenCap: parsed.data.llm.maxOutputTokenCap,
    retryAttempts: parsed.data.llm.retryAttempts,
  });

  const [azureResult, llmResult] = await Promise.allSettled([
    azureAdapter.testConnection(),
    parsed.data.llm.provider === "ollama" || parsed.data.llm.apiKey
      ? llmProvider.testConnection()
      : Promise.resolve(false),
  ]);

  const azureDevOps =
    azureResult.status === "fulfilled"
      ? { success: azureResult.value }
      : { success: false, error: azureResult.reason instanceof Error ? azureResult.reason.message : "Azure DevOps test failed." };

  const llm =
    llmResult.status === "fulfilled"
      ? { success: llmResult.value }
      : { success: false, error: llmResult.reason instanceof Error ? llmResult.reason.message : "LLM test failed." };

  return NextResponse.json({
    success: Boolean(azureDevOps.success && llm.success),
    azureDevOps,
    llm,
  });
}
