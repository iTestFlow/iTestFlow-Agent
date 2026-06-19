import "server-only";

import { AppErrorCode, isAppError, type ErrorTechnicalContext } from "./app-error";

export type ErrorResponseBody = {
  error: string;
  code: AppErrorCode;
  technicalDetails?: string;
  technicalContext?: ErrorTechnicalContext;
};

const RAW_OUTPUT_LABEL = "Raw output excerpt";

export function toErrorResponse(error: unknown): ErrorResponseBody {
  if (!isAppError(error)) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    return {
      error: message,
      code: AppErrorCode.Unknown,
      technicalDetails: message,
    };
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

export function statusForServerError(error: unknown) {
  if (!isAppError(error)) return 500;
  return statusForCode(error.code);
}

export function statusForManualValidationError(error: unknown) {
  if (isAppError(error) && (error.code === AppErrorCode.InvalidJson || error.code === AppErrorCode.SchemaValidation)) {
    return 422;
  }
  return statusForServerError(error);
}

export function statusForCode(code: AppErrorCode) {
  switch (code) {
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
  if (context?.parsePosition !== undefined) lines.push(`Parse position: ${context.parsePosition}`);
  if (context?.jsonSnippet) lines.push(`JSON snippet: ${context.jsonSnippet}`);
  if (context?.rawOutputExcerpt) lines.push(`${RAW_OUTPUT_LABEL}: ${context.rawOutputExcerpt}`);
  if (input.message) lines.push(`Raw error: ${input.message}`);

  const rendered = lines.join("\n");
  if (rendered && rendered !== input.friendlyMessage) return rendered;
  return input.message && input.message !== input.friendlyMessage ? input.message : undefined;
}

function formatTokenUsage(tokenUsage: NonNullable<ErrorTechnicalContext["tokenUsage"]>) {
  const segments = [
    tokenUsage.input !== undefined ? `input=${tokenUsage.input}` : undefined,
    tokenUsage.output !== undefined ? `output=${tokenUsage.output}` : undefined,
    tokenUsage.total !== undefined ? `total=${tokenUsage.total}` : undefined,
  ].filter(Boolean);
  return segments.length ? segments.join(", ") : "unknown";
}
