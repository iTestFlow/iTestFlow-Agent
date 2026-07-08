import type { ProviderId } from "./provider-types";

export const INTEGRATION_ERROR_CODES = [
  "integration_auth_failed",
  "integration_permission_denied",
  "integration_not_found",
  "integration_rate_limited",
  "integration_unavailable",
  "integration_invalid_response",
  "integration_validation",
  "integration_unsupported_capability",
  "integration_unsupported_provider",
  "integration_configuration",
  "integration_unknown",
] as const;

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export type IntegrationErrorOptions = {
  providerId?: ProviderId | string;
  code: IntegrationErrorCode;
  message: string;
  statusCode?: number;
  cause?: unknown;
};

export class IntegrationError extends Error {
  readonly providerId?: ProviderId | string;
  readonly code: IntegrationErrorCode;
  readonly statusCode?: number;

  constructor(options: IntegrationErrorOptions) {
    super(options.message);
    this.name = "IntegrationError";
    this.providerId = options.providerId;
    this.code = options.code;
    this.statusCode = options.statusCode;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isIntegrationError(error: unknown): error is IntegrationError {
  if (error instanceof IntegrationError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    INTEGRATION_ERROR_CODES.includes(candidate.code as IntegrationErrorCode) &&
    (candidate.providerId === undefined || typeof candidate.providerId === "string") &&
    (candidate.statusCode === undefined || typeof candidate.statusCode === "number")
  );
}
