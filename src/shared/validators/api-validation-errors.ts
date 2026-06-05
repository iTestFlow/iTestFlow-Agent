import type { ZodError } from "zod";

export type ApiErrorPayload = {
  error?: string;
  validationErrors?: Array<{
    field: string;
    label: string;
    message: string;
  }>;
};

/**
 * Client-side counterpart to {@link zodErrorResponse}: turn a parsed JSON error body into a
 * human-readable message, falling back to `fallback` when the payload has no usable detail.
 */
export function apiErrorMessage(payload: unknown, fallback: string): string {
  const json = payload as ApiErrorPayload;
  if (json?.error) return json.error;
  if (json?.validationErrors?.length) {
    return json.validationErrors.map((item) => `${item.label}: ${item.message}`).join(" ");
  }
  return fallback;
}

const fieldLabels: Record<string, string> = {
  "azureDevOps.organizationUrl": "Azure DevOps Organization URL",
  "azureDevOps.personalAccessToken": "Azure DevOps Personal Access Token",
  "llm.provider": "LLM Provider",
  "llm.model": "LLM Model",
  "llm.apiKey": "LLM API Token",
  "llm.baseUrl": "LLM Base URL",
  "llm.temperature": "LLM Temperature",
  "llm.maxTokens": "LLM Max Tokens",
  "llm.retryAttempts": "LLM Retry Attempts",
  "context.retrievalTopK": "Project Context Retrieval Count",
  "context.autoUpdate.cronExpression": "Auto Update Cron Expression",
  "context.autoUpdate.projectScope": "Auto Update Project",
  "context.autoUpdate.workItemTypes": "Auto Update Work Item Types",
  "context.autoUpdate.states": "Auto Update States",
  provider: "LLM Provider",
  apiKey: "LLM API Token",
  baseUrl: "LLM Base URL",
};

export function zodErrorResponse(message: string, error: ZodError) {
  const validationErrors = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return {
      field: path,
      label: fieldLabels[path] ?? path,
      message: issue.message,
    };
  });

  return {
    error: `${message} ${formatValidationErrors(validationErrors)}`,
    validationErrors,
  };
}

function formatValidationErrors(errors: Array<{ label: string; message: string }>) {
  if (!errors.length) return "Please review the highlighted fields.";
  return errors.map((error) => `${error.label}: ${error.message}`).join(" ");
}
