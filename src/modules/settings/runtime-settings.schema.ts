import { z } from "zod";

export const LLMProviderNameSchema = z.enum(["openai", "gemini", "anthropic"]);

export const RuntimeSettingsInputSchema = z.object({
  azureDevOps: z.object({
    organizationUrl: z.string({
      required_error: "Enter your Azure DevOps organization URL.",
      invalid_type_error: "Enter your Azure DevOps organization URL.",
    }).trim().min(1, "Enter your Azure DevOps organization URL.").url("Enter a valid Azure DevOps organization URL, for example https://dev.azure.com/your-org."),
    personalAccessToken: z.string({
      required_error: "Enter your Azure DevOps Personal Access Token.",
      invalid_type_error: "Enter your Azure DevOps Personal Access Token.",
    }).min(1, "Enter your Azure DevOps Personal Access Token."),
  }),
  llm: z.object({
    provider: LLMProviderNameSchema,
    model: z.string({
      required_error: "Select an LLM model.",
      invalid_type_error: "Select an LLM model.",
    }).trim().min(1, "Select an LLM model."),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    temperature: z.number().min(0, "Temperature must be 0 or higher.").max(2, "Temperature must be 2 or lower.").default(0.2),
    maxTokens: z.number().int("Max tokens must be a whole number.").positive("Max tokens must be greater than 0.").default(4000),
    retryAttempts: z.number().int("Retry attempts must be a whole number.").min(0, "Retry attempts cannot be negative.").max(5, "Retry attempts must be 5 or lower.").default(1),
  }),
  context: z.object({
    retrievalTopK: z.number().int("Context retrieval count must be a whole number.").min(1, "Context retrieval count must be at least 1.").max(25, "Context retrieval count must be 25 or lower.").default(8),
  }).default({ retrievalTopK: 8 }),
});

export type RuntimeSettingsInput = z.infer<typeof RuntimeSettingsInputSchema>;

export type RuntimeSettings = RuntimeSettingsInput & {
  savedAt: string;
};

export type RuntimeSettingsSummary = {
  configured: boolean;
  savedAt?: string;
  azureDevOps?: {
    organizationUrl: string;
    hasPersonalAccessToken: boolean;
  };
  llm?: {
    provider: RuntimeSettingsInput["llm"]["provider"];
    model: string;
    baseUrl?: string;
    hasApiKey: boolean;
    temperature: number;
    maxTokens: number;
    retryAttempts: number;
  };
  context?: {
    retrievalTopK: number;
  };
};
