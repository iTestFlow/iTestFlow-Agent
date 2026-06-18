import { describeCron, findNextCronRun } from "@/shared/lib/cron-schedule";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import type { LatestAutoUpdateRun, ServiceTestResult, StatusValue } from "./types";

/**
 * Pure status derivation for the summary cards. Ephemeral test results take
 * precedence; otherwise status is inferred from the saved/typed configuration.
 */

export function deriveAzureStatus(input: {
  organizationUrl: string;
  personalAccessToken: string;
  hasSavedPat: boolean;
  testResult?: ServiceTestResult;
}): StatusValue {
  if (input.testResult?.success === true) return { tone: "success", label: "Connected" };
  if (input.testResult?.success === false) {
    return { tone: "destructive", label: "Failed", detail: input.testResult.error };
  }
  if (!input.organizationUrl.trim()) return { tone: "muted", label: "Not configured" };
  if (!input.hasSavedPat && !input.personalAccessToken.trim()) {
    return { tone: "warning", label: "Needs token" };
  }
  return { tone: "info", label: "Configured" };
}

export function deriveAiStatus(input: {
  provider: string;
  model: string;
  apiKey: string;
  canUseSavedLlmKey: boolean;
  testResult?: ServiceTestResult;
}): StatusValue {
  if (input.testResult?.success === true) {
    return { tone: "success", label: "Connected", detail: input.model || undefined };
  }
  if (input.testResult?.success === false) {
    return { tone: "destructive", label: "Failed", detail: input.testResult.error };
  }
  if (!input.model.trim()) return { tone: "warning", label: "Model unavailable" };
  if (!input.canUseSavedLlmKey && !input.apiKey.trim()) {
    return { tone: "warning", label: "Needs token" };
  }
  return { tone: "info", label: "Configured", detail: input.model };
}

export function deriveSyncStatus(input: {
  enabled: boolean;
  project: ActiveProjectScope | null;
  workItemTypes: string[];
  states: string[];
  cronExpression: string;
  latestRun: LatestAutoUpdateRun | null;
}): StatusValue {
  if (!input.enabled) return { tone: "muted", label: "Disabled" };
  if (!input.project) return { tone: "warning", label: "No project selected" };
  if (!input.workItemTypes.length || !input.states.length) {
    return { tone: "warning", label: "Filters incomplete" };
  }
  const next = findNextCronRun(input.cronExpression);
  const detail = next ? `Next run: ${formatDateTime(next)}` : describeCron(input.cronExpression);
  return { tone: "success", label: "Enabled", detail };
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
