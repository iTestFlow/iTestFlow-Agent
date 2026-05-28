import { z } from "zod";
import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults";
import { DEFAULT_AUTO_UPDATE_CRON_EXPRESSION, validateCronExpression } from "./cron-expression";

export const LLMProviderNameSchema = z.enum(["openai", "gemini", "anthropic"]);

const ProjectScopeSettingsSchema = z.object({
  projectId: z.string().min(1),
  azureProjectId: z.string().min(1),
  azureProjectName: z.string().min(1),
  azureOrganizationUrl: z.string().url(),
});

const FilterValuesSchema = (defaults: string[]) =>
  z.array(z.string()).default(defaults).transform((values) => normalizeFilterValues(values));

const AutoUpdateSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  cronExpression: z.string().trim().default(DEFAULT_AUTO_UPDATE_CRON_EXPRESSION).superRefine((value, ctx) => {
    const error = validateCronExpression(value);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }),
  projectScope: ProjectScopeSettingsSchema.nullable().default(null),
  workItemTypes: FilterValuesSchema(DEFAULT_CONTEXT_WORK_ITEM_TYPES),
  states: FilterValuesSchema(DEFAULT_CONTEXT_STATES),
}).superRefine((value, ctx) => {
  if (!value.enabled) return;
  if (!value.projectScope) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectScope"],
      message: "Select an Azure DevOps project before enabling automatic project context updates.",
    });
  }
  if (!value.workItemTypes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workItemTypes"],
      message: "Select at least one work item type for automatic project context updates.",
    });
  }
  if (!value.states.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["states"],
      message: "Select at least one state for automatic project context updates.",
    });
  }
});

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
    autoUpdate: AutoUpdateSettingsSchema.default({
      enabled: false,
      cronExpression: DEFAULT_AUTO_UPDATE_CRON_EXPRESSION,
      projectScope: null,
      workItemTypes: DEFAULT_CONTEXT_WORK_ITEM_TYPES,
      states: DEFAULT_CONTEXT_STATES,
    }),
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
    autoUpdate: {
      enabled: boolean;
      cronExpression: string;
      projectScope: z.infer<typeof ProjectScopeSettingsSchema> | null;
      workItemTypes: string[];
      states: string[];
      latestRun?: {
        id: string;
        status: string;
        startedAt: string;
        completedAt?: string | null;
        workItemTypes?: string[];
        states?: string[];
        contextIndexedWorkItemCount?: number;
        contextIndexedChunkCount?: number;
        knowledgeSourceWorkItemCount?: number;
        errorDetails?: string | null;
      } | null;
    };
  };
};

function normalizeFilterValues(values: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}
