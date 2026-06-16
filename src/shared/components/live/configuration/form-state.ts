import {
  DEFAULT_CONTEXT_STATES,
  DEFAULT_CONTEXT_WORK_ITEM_TYPES,
} from "@/lib/project-context-defaults";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  DEFAULT_RETRY_ATTEMPTS,
} from "@/modules/llm/llm-defaults";
import { DEFAULT_AUTO_UPDATE_CRON_EXPRESSION } from "@/modules/settings/cron-expression";
import { projectScopeKey } from "@/shared/lib/use-project-work-item-metadata";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import type { Provider } from "./types";
import { defaultWorkflowBaselines } from "@/modules/analytics/analytics-config";

export type FormState = {
  organizationUrl: string;
  personalAccessToken: string;
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxOutputTokenCap: number;
  retryAttempts: number;
  retrievalTopK: number;
  autoUpdateEnabled: boolean;
  autoUpdateCronExpression: string;
  autoUpdateProjectScope: ActiveProjectScope | null;
  autoUpdateWorkItemTypes: string[];
  autoUpdateStates: string[];
  dashboardValueMetrics: {
    feedbackPromptEnabled: boolean;
    manualBaselineMinutes: typeof defaultWorkflowBaselines;
  };
};

export const INITIAL_FORM: FormState = {
  organizationUrl: "",
  personalAccessToken: "",
  provider: "openai",
  model: "",
  apiKey: "",
  baseUrl: "",
  maxOutputTokenCap: DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  retryAttempts: DEFAULT_RETRY_ATTEMPTS,
  retrievalTopK: 8,
  autoUpdateEnabled: false,
  autoUpdateCronExpression: DEFAULT_AUTO_UPDATE_CRON_EXPRESSION,
  autoUpdateProjectScope: null,
  autoUpdateWorkItemTypes: DEFAULT_CONTEXT_WORK_ITEM_TYPES,
  autoUpdateStates: DEFAULT_CONTEXT_STATES,
  dashboardValueMetrics: {
    feedbackPromptEnabled: true,
    manualBaselineMinutes: { ...defaultWorkflowBaselines },
  },
};

/**
 * Structural equality of two form snapshots, used for dirty detection against the
 * saved baseline. Filter arrays are compared order-insensitively, and the project
 * scope by its stable key. Secrets compare by value: the loaded baseline holds an
 * empty string (the API never returns secrets), so a typed-then-cleared secret
 * correctly returns to "not dirty".
 */
export function formsEqual(a: FormState, b: FormState): boolean {
  return (
    a.organizationUrl === b.organizationUrl &&
    a.personalAccessToken === b.personalAccessToken &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.apiKey === b.apiKey &&
    a.baseUrl === b.baseUrl &&
    a.maxOutputTokenCap === b.maxOutputTokenCap &&
    a.retryAttempts === b.retryAttempts &&
    a.retrievalTopK === b.retrievalTopK &&
    a.autoUpdateEnabled === b.autoUpdateEnabled &&
    a.autoUpdateCronExpression === b.autoUpdateCronExpression &&
    projectScopeKey(a.autoUpdateProjectScope) === projectScopeKey(b.autoUpdateProjectScope) &&
    sameStringSet(a.autoUpdateWorkItemTypes, b.autoUpdateWorkItemTypes) &&
    sameStringSet(a.autoUpdateStates, b.autoUpdateStates) &&
    JSON.stringify(a.dashboardValueMetrics) === JSON.stringify(b.dashboardValueMetrics)
  );
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}
