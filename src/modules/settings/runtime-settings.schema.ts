import { z } from "zod";
import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  DEFAULT_RETRY_ATTEMPTS,
  MAX_OUTPUT_TOKEN_CAP_OPTIONS,
  RETRY_ATTEMPT_OPTIONS,
} from "@/modules/llm/llm-defaults";
import { DEFAULT_AUTO_UPDATE_CRON_EXPRESSION, validateCronExpression } from "./cron-expression";
import {
  defaultWorkflowBaselines,
  workflowTypeValues,
} from "@/modules/analytics/analytics-config";

export const LLMProviderNameSchema = z.enum(["openai", "gemini", "anthropic", "ollama"]);

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

const LLMSettingsSchema = z.object({
  provider: LLMProviderNameSchema,
  model: z.string({
    required_error: "Select an LLM model.",
    invalid_type_error: "Select an LLM model.",
  }).trim().min(1, "Select an LLM model."),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  maxOutputTokenCap: allowedNumber(
    MAX_OUTPUT_TOKEN_CAP_OPTIONS,
    "Select a supported maximum output token cap.",
  ).default(DEFAULT_MAX_OUTPUT_TOKEN_CAP),
  retryAttempts: allowedNumber(
    RETRY_ATTEMPT_OPTIONS,
    "Select a supported transient retry count.",
  ).default(DEFAULT_RETRY_ATTEMPTS),
});

const ManualBaselineMinutesSchema = z.object(
  Object.fromEntries(
    workflowTypeValues.map((workflowType) => [
      workflowType,
      z.number().finite().min(0).max(1440).default(defaultWorkflowBaselines[workflowType]),
    ]),
  ) as Record<(typeof workflowTypeValues)[number], z.ZodDefault<z.ZodNumber>>,
);

export const DashboardValueMetricsSettingsSchema = z.object({
  manualBaselineMinutes: ManualBaselineMinutesSchema.default(defaultWorkflowBaselines),
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
  llm: LLMSettingsSchema,
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
  dashboardValueMetrics: DashboardValueMetricsSettingsSchema.default({
    manualBaselineMinutes: defaultWorkflowBaselines,
  }),
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
    maxOutputTokenCap: number;
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
        cronTimezone?: string;
        workItemTypes?: string[];
        states?: string[];
        contextSyncMode?: string | null;
        contextIndexedWorkItemCount?: number;
        contextIndexedChunkCount?: number;
        contextCreatedCount?: number;
        contextUpdatedCount?: number;
        contextUnchangedCount?: number;
        contextInactiveCount?: number;
        contextSkippedEmptyCount?: number;
        knowledgeSourceWorkItemCount?: number;
        knowledgeCompileMode?: string | null;
        knowledgeCompileStatus?: string;
        knowledgeCompileSkippedReason?: string | null;
        errorDetails?: string | null;
      } | null;
    };
  };
  dashboardValueMetrics?: RuntimeSettingsInput["dashboardValueMetrics"];
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

function allowedNumber(options: readonly number[], message: string) {
  return z.number().int().refine((value) => options.includes(value), { message });
}
