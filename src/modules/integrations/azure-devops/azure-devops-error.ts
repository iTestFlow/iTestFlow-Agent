import { IntegrationError, type IntegrationErrorCode } from "../core/integration-error";
import { formatAzureDevOpsError } from "@/shared/lib/sanitize-azure-error";

const AZURE_DEVOPS_PROVIDER_ID = "azure-devops";

export function azureDevOpsIntegrationError(status: number, body: string, path = "") {
  return new IntegrationError({
    providerId: AZURE_DEVOPS_PROVIDER_ID,
    code: integrationCodeForStatus(status),
    statusCode: status,
    message: formatAzureDevOpsError(status, body, path),
  });
}

export function azureDevOpsInvalidResponseError(message: string, status: number) {
  return new IntegrationError({
    providerId: AZURE_DEVOPS_PROVIDER_ID,
    code: "integration_invalid_response",
    statusCode: status,
    message,
  });
}

export function azureDevOpsTransportError(cause: unknown, fallbackMessage = "") {
  return new IntegrationError({
    providerId: AZURE_DEVOPS_PROVIDER_ID,
    code: "integration_unavailable",
    message: cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : fallbackMessage,
    cause,
  });
}

export function integrationCodeForStatus(status: number): IntegrationErrorCode {
  if (status === 401) return "integration_auth_failed";
  if (status === 403) return "integration_permission_denied";
  if (status === 404) return "integration_not_found";
  if (status === 429) return "integration_rate_limited";
  if (status === 408 || status >= 500) return "integration_unavailable";
  if (status === 400 || status === 409 || status === 422) return "integration_validation";
  return "integration_unknown";
}
