import "server-only";

import { isIntegrationError, type IntegrationErrorCode } from "@/modules/integrations/core/integration-error";
import { AppErrorCode, isAppError, type ErrorTechnicalContext } from "./app-error";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";

export type ErrorResponseBody = {
  error: string;
  code?: AppErrorCode;
  technicalDetails?: string;
  technicalContext?: ErrorTechnicalContext;
};

export type ErrorDomain = "llm" | "azure" | "auth" | "settings" | "generic";

export type FriendlyErrorOptions = {
  domain?: ErrorDomain;
  fallback?: string;
  provider?: string;
  status?: number;
  technicalDetails?: string;
};

export type FriendlyErrorResult = {
  body: ErrorResponseBody;
  status: number;
};

const RAW_OUTPUT_LABEL = "Raw output excerpt";
const MAX_TECHNICAL_DETAILS_CHARS = 1200;

export function toErrorResponse(error: unknown, options: FriendlyErrorOptions = {}): ErrorResponseBody {
  if (!isAppError(error)) {
    return normalizePlainError(error, options).body;
  }

  const technicalContext = clientTechnicalContext(error.technicalContext);
  const technicalDetails = renderTechnicalDetails({
    message: error.message,
    context: technicalContext,
    friendlyMessage: error.userMessage,
  });

  return {
    error: error.userMessage,
    code: error.code,
    technicalDetails,
    technicalContext,
  };
}

export function toFriendlyErrorResponse(error: unknown, options: FriendlyErrorOptions = {}): FriendlyErrorResult {
  if (isIntegrationError(error)) {
    return {
      body: normalizePlainError(error, options).body,
      status: statusForIntegrationErrorCode(error.code),
    };
  }
  if (isAppError(error)) {
    return { body: toErrorResponse(error, options), status: statusForServerError(error, options) };
  }
  return normalizePlainError(error, options);
}

export function friendlyErrorMessage(error: unknown, options: FriendlyErrorOptions = {}) {
  return toFriendlyErrorResponse(error, options).body.error;
}

export function statusForServerError(error: unknown, options: FriendlyErrorOptions = {}) {
  if (isIntegrationError(error)) return statusForIntegrationErrorCode(error.code);
  if (!isAppError(error)) return options.status ?? 500;
  return options.status ?? statusForCode(error.code);
}

export function statusForManualValidationError(error: unknown) {
  if (isAppError(error) && (error.code === AppErrorCode.InvalidJson || error.code === AppErrorCode.SchemaValidation)) {
    return 422;
  }
  return statusForServerError(error);
}

export function statusForCode(code: AppErrorCode) {
  switch (code) {
    case AppErrorCode.KnowledgeDraftConflict:
    case AppErrorCode.KnowledgeContractMismatch:
      return 409;
    case AppErrorCode.KnowledgePublicationBlocked:
      return 422;
    case AppErrorCode.KnowledgeDraftNotFound:
    case AppErrorCode.ResourceNotFound:
      return 404;
    case AppErrorCode.Network:
      return 502;
    case AppErrorCode.TokenLimit:
    case AppErrorCode.InvalidJson:
    case AppErrorCode.SchemaValidation:
    case AppErrorCode.ProviderUnavailable:
    case AppErrorCode.NoProvider:
      return 503;
    case AppErrorCode.Unknown:
    default:
      return 500;
  }
}

export function statusForIntegrationErrorCode(code: IntegrationErrorCode) {
  switch (code) {
    case "integration_auth_failed":
      return 401;
    case "integration_permission_denied":
      return 403;
    case "integration_not_found":
      return 404;
    case "integration_rate_limited":
      return 429;
    case "integration_validation":
      return 422;
    case "integration_invalid_response":
      return 502;
    case "integration_unavailable":
      return 503;
    case "integration_unsupported_capability":
    case "integration_unsupported_provider":
    case "integration_configuration":
    case "integration_unknown":
    default:
      return 500;
  }
}

function clientTechnicalContext(context?: ErrorTechnicalContext): ErrorTechnicalContext | undefined {
  if (!context) return undefined;
  if (process.env.NODE_ENV !== "production") {
    return context;
  }
  const safeContext = Object.fromEntries(
    Object.entries(context).filter(([key]) => key !== "rawOutputExcerpt"),
  ) as ErrorTechnicalContext;
  return Object.keys(safeContext).length ? safeContext : undefined;
}

function renderTechnicalDetails(input: {
  message: string;
  context?: ErrorTechnicalContext;
  friendlyMessage: string;
}) {
  const lines: string[] = [];
  const { context } = input;
  if (context?.provider) lines.push(`Provider: ${context.provider}`);
  if (context?.model) lines.push(`Model: ${context.model}`);
  if (context?.schemaName) lines.push(`Schema: ${context.schemaName}`);
  if (context?.finishReason) lines.push(`Finish reason: ${context.finishReason}`);
  if (context?.tokenUsage) lines.push(`Tokens: ${formatTokenUsage(context.tokenUsage)}`);
  if (context?.durationMs !== undefined) lines.push(`Duration: ${formatDurationMs(context.durationMs)}`);
  if (context?.retryAttempts !== undefined) lines.push(`Retry attempts: ${context.retryAttempts}`);
  if (context?.upstreamCause) lines.push(`Upstream cause: ${context.upstreamCause}`);
  if (context?.parsePosition !== undefined) lines.push(`Parse position: ${context.parsePosition}`);
  if (context?.jsonSnippet) lines.push(`JSON snippet: ${context.jsonSnippet}`);
  if (context?.rawOutputExcerpt) lines.push(`${RAW_OUTPUT_LABEL}: ${context.rawOutputExcerpt}`);
  if (input.message) lines.push(`Raw error: ${input.message}`);

  const rendered = lines.join("\n");
  if (rendered && rendered !== input.friendlyMessage) return rendered;
  return input.message && input.message !== input.friendlyMessage ? input.message : undefined;
}

function normalizePlainError(error: unknown, options: FriendlyErrorOptions): FriendlyErrorResult {
  const rawMessage = rawErrorMessage(error);
  const explicitDetails = options.technicalDetails?.trim();
  const diagnostic = explicitDetails || rawMessage;
  const explicitStatus = options.status !== undefined;
  const status = options.status ?? 500;
  const code = options.domain === "llm" ? inferCode(rawMessage) : AppErrorCode.Unknown;
  const errorText = classifyFriendlyMessage(rawMessage, {
    ...options,
    status,
    explicitStatus,
    provider: options.provider ?? detectProvider(rawMessage),
  });
  const technicalDetails = renderPlainTechnicalDetails(diagnostic, errorText, status);

  return {
    body: {
      error: errorText,
      ...(code !== AppErrorCode.Unknown ? { code } : {}),
      ...(technicalDetails ? { technicalDetails } : {}),
    },
    status,
  };
}

function rawErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "An unexpected error occurred.";
}

function classifyFriendlyMessage(
  raw: string,
  options: Required<Pick<FriendlyErrorOptions, "status">> & FriendlyErrorOptions & { explicitStatus: boolean },
) {
  const fallback = options.fallback ?? defaultFallback(options.domain);
  const hasExplicitFallback = typeof options.fallback === "string" && options.fallback.trim().length > 0;
  const text = normalizeForSearch(raw);
  const provider = options.provider ? providerLabel(options.provider) : undefined;
  const sanitizedRaw = capTechnicalDetails(redactSecrets(sanitizeAzureError(raw))).trim();

  if (isInvalidApiKey(text)) {
    if (options.domain === "azure" || text.includes("personal access token") || /\bpat\b/.test(text)) {
      return "Azure DevOps authentication failed. Check that your Personal Access Token is valid and has not expired, then try again.";
    }
    return provider
      ? `${provider} rejected the API key. Check that the key is correct and belongs to ${provider}, then try again.`
      : "The provider rejected the API key. Check that the key is correct, saved for the selected provider, and try again.";
  }

  if (isAzureMissingIdentity(text)) {
    return "Azure DevOps did not return an identity for this token. Check that the PAT belongs to the selected organization and try again.";
  }

  if (isUnauthorized(text, options.status)) {
    if (hasExplicitFallback && (options.domain === "auth" || options.domain === "settings" || options.domain === "azure")) {
      return fallback;
    }
    return options.domain === "azure" || options.domain === "auth"
      ? "Authentication failed. Sign in again or update the saved credential, then try again."
      : "The provider rejected the saved credentials. Update your credentials in Settings, then try again.";
  }

  if (isForbidden(text, options.status)) {
    if (hasExplicitFallback && (options.domain === "auth" || options.domain === "settings")) {
      return fallback;
    }
    return options.domain === "azure"
      ? "Azure DevOps denied this request. Ask an Azure DevOps administrator to check your project permissions and PAT scopes, then try again."
      : provider
        ? `${provider} rejected the request. Check that your API key has permission for this action.`
        : "You do not have permission to complete this action. Check your access and try again.";
  }

  if (isAzureWorkItemMissingOrUnauthorized(text)) {
    return "The work item was not found in the selected Azure DevOps project, or your account cannot read it. Check the ID and selected project, then try again.";
  }

  if (isRateLimit(text, options.status)) {
    return provider
      ? `${provider} could not complete the request because the provider rate limit or quota was reached. Wait a moment, then try again.`
      : "The request could not be completed because a rate limit or quota was reached. Wait a moment, then try again.";
  }

  if (isEndpointProblem(text, options.status)) {
    if (hasExplicitFallback && (options.domain === "auth" || options.domain === "settings")) {
      return fallback;
    }
    return provider
      ? `${provider} could not find the requested endpoint. Check the optional provider base URL and try again.`
      : "The requested endpoint could not be found. Refresh the page and try again.";
  }

  if (!options.explicitStatus && isNetworkProblem(text)) {
    return provider
      ? `Could not connect to ${provider}. Check your network connection and provider base URL, then try again.`
      : "Network error. Check your connection and try again.";
  }

  if (isProviderUnavailable(text)) {
    return provider
      ? `${provider} is temporarily unavailable. Try again in a moment.`
      : "The service is temporarily unavailable. Try again in a moment.";
  }

  if (looksLikeRawJson(raw) || looksLikeHtml(raw)) {
    return fallback;
  }

  if (isCuratedFriendlyMessage(sanitizedRaw, options.domain)) {
    return sanitizedRaw;
  }

  if (isNonJsonProblem(text)) {
    return "The server returned an unexpected response. Please try again.";
  }

  if (isValidationStatus(options.status)) {
    return sanitizedRaw;
  }

  return fallback;
}

function renderPlainTechnicalDetails(raw: string, friendly: string, status: number) {
  const sanitized = capTechnicalDetails(redactSecrets(sanitizeAzureError(raw)));
  if (!sanitized || sanitized === friendly) return undefined;
  return [`HTTP status: ${status}`, `Raw error: ${sanitized}`].join("\n");
}

function redactSecrets(value: string) {
  return value
    .replace(/(api[_-]?key|x-api-key|personalAccessToken|pat)(["'\s:=]+)([^"',\s}]+)/gi, "$1$2[redacted]")
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{20,}/gi, "$1[redacted]")
    .replace(/sk-[A-Za-z0-9_\-]{8,}/gi, "sk-[redacted]")
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza[redacted]");
}

function capTechnicalDetails(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_TECHNICAL_DETAILS_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TECHNICAL_DETAILS_CHARS)}...`;
}

function normalizeForSearch(value: string) {
  return value.toLowerCase();
}

function inferCode(raw: string) {
  const text = normalizeForSearch(raw);
  if (isNetworkProblem(text)) return AppErrorCode.Network;
  if (hasProviderUnavailableSignal(text)) return AppErrorCode.ProviderUnavailable;
  return AppErrorCode.Unknown;
}

function defaultFallback(domain?: ErrorDomain) {
  switch (domain) {
    case "llm":
      return "The AI provider could not complete the request. Please try again in a moment or check the provider settings.";
    case "azure":
      return "Azure DevOps could not complete the request. Check your access and try again.";
    case "auth":
      return "Authentication failed. Check your credentials and try again.";
    case "settings":
      return "The settings update could not be completed. Please try again.";
    case "generic":
    default:
      return "The request could not be completed. Please try again.";
  }
}

function providerLabel(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("openai")) return "OpenAI";
  if (normalized.includes("gemini") || normalized.includes("google")) return "Gemini";
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "Anthropic";
  return value;
}

function detectProvider(value: string) {
  const text = normalizeForSearch(value);
  if (text.includes("openai")) return "openai";
  if (text.includes("gemini") || text.includes("googleapis") || text.includes("generativelanguage")) return "gemini";
  if (text.includes("anthropic") || text.includes("claude")) return "anthropic";
  return undefined;
}

function isInvalidApiKey(text: string) {
  return (
    text.includes("api key not valid") ||
    text.includes("invalid api key") ||
    text.includes("incorrect api key") ||
    text.includes("invalid_api_key") ||
    text.includes("authentication_error") ||
    (text.includes("invalid_argument") && text.includes("api key")) ||
    text.includes("x-api-key") ||
    text.includes("invalid x-api-key") ||
    text.includes("pat validation failed") ||
    text.includes("invalid personal access token") ||
    (text.includes("personal access token") && (text.includes("invalid") || text.includes("rejected") || text.includes("expired")))
  );
}

function isAzureMissingIdentity(text: string) {
  return text.includes("azure devops did not return an identity for this token");
}

function isUnauthorized(text: string, status: number) {
  return status === 401 || text.includes("unauthorized") || text.includes("unauthenticated") || text.includes("expired");
}

function isForbidden(text: string, status: number) {
  return status === 403 || text.includes("forbidden") || text.includes("permission denied") || text.includes("access denied");
}

function isRateLimit(text: string, status: number) {
  return status === 429 || text.includes("rate limit") || text.includes("quota") || text.includes("resource_exhausted");
}

function isEndpointProblem(text: string, status: number) {
  return status === 404 || text.includes("unknown url") || text.includes("invalid base url") || (text.includes("endpoint") && text.includes("not found"));
}

function isNetworkProblem(text: string) {
  return /failed to fetch|network\s*error|fetch failed|econnreset|etimedout|enotfound|eai_again|headers timeout|body timeout|socket|terminated/i.test(text);
}

function isProviderUnavailable(text: string) {
  return hasProviderUnavailableSignal(text);
}

function hasProviderUnavailableSignal(text: string) {
  return text.includes("overloaded") || text.includes("unavailable") || text.includes("bad gateway") || text.includes("gateway timeout");
}

function isValidationStatus(status: number) {
  return status === 400 || status === 409 || status === 422;
}

function isAzureWorkItemMissingOrUnauthorized(text: string) {
  const mentionsWorkItem = text.includes("work item") || text.includes("workitem");
  return mentionsWorkItem && (text.includes("tf401232") || (text.includes("does not exist") && text.includes("permission")));
}

function isCuratedFriendlyMessage(value: string, domain?: ErrorDomain) {
  if (domain !== "azure") return false;
  if (!value || looksLikeRawJson(value) || looksLikeHtml(value)) return false;
  return (
    /^Azure DevOps (?:request failed|denied|authentication failed)/i.test(value) ||
    /^Azure DevOps returned/i.test(value) ||
    /^Your Azure DevOps account/i.test(value) ||
    /^You don(?:'|\u2019)t have access to Azure Test Plans/i.test(value) ||
    /^Selected suite .+ was not found/i.test(value) ||
    /^Parent suite .+ was not found/i.test(value) ||
    /^Target parent suite .+ was not found/i.test(value) ||
    /^Target parent suite cannot be one of the selected source suites/i.test(value) ||
    /^Only static suites can be selected/i.test(value)
  );
}

function isNonJsonProblem(text: string) {
  return text.includes("non-json") || text.includes("malformed json") || text.includes("invalid json") || text.includes("unexpected response");
}

function looksLikeRawJson(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.includes('{"error"') || trimmed.includes('"error":');
}

function looksLikeHtml(value: string) {
  return /<html|<!doctype html|<body|<pre/i.test(value);
}

function formatTokenUsage(tokenUsage: NonNullable<ErrorTechnicalContext["tokenUsage"]>) {
  const segments = [
    tokenUsage.input !== undefined ? `input=${tokenUsage.input}` : undefined,
    tokenUsage.output !== undefined ? `output=${tokenUsage.output}` : undefined,
    tokenUsage.total !== undefined ? `total=${tokenUsage.total}` : undefined,
  ].filter(Boolean);
  return segments.length ? segments.join(", ") : "unknown";
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1000) return `${durationMs} ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
