import type { TokenUsage } from "@/modules/llm/llm-types";

export enum AppErrorCode {
  TokenLimit = "token_limit",
  InvalidJson = "invalid_json",
  SchemaValidation = "schema_validation",
  ProviderUnavailable = "provider_unavailable",
  NoProvider = "no_provider",
  Network = "network",
  Unknown = "unknown",
}

export type ErrorTechnicalContext = {
  provider?: string;
  model?: string;
  schemaName?: string;
  finishReason?: string;
  tokenUsage?: TokenUsage;
  parsePosition?: number;
  jsonSnippet?: string;
  rawOutputExcerpt?: string;
};

export type AppErrorOptions = {
  code: AppErrorCode;
  message: string;
  userMessage: string;
  technicalContext?: ErrorTechnicalContext;
};

const MAX_JSON_SNIPPET_CHARS = 300;
const MAX_RAW_OUTPUT_EXCERPT_CHARS = 800;

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly technicalContext?: ErrorTechnicalContext;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.technicalContext = normalizeTechnicalContext(options.technicalContext);
  }
}

export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    typeof candidate.userMessage === "string" &&
    isAppErrorCode(candidate.code)
  );
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && Object.values(AppErrorCode).includes(value as AppErrorCode);
}

export function noLlmProviderConfiguredError() {
  return new AppError({
    code: AppErrorCode.NoProvider,
    message: "No LLM provider configured. Add an LLM provider and API key in Settings → My Credentials.",
    userMessage: "No LLM provider is configured. Configure a provider, model, and API key in Settings.",
  });
}

function normalizeTechnicalContext(context?: ErrorTechnicalContext): ErrorTechnicalContext | undefined {
  if (!context) return undefined;
  const normalized: ErrorTechnicalContext = {
    provider: context.provider,
    model: context.model,
    schemaName: context.schemaName,
    finishReason: context.finishReason,
    tokenUsage: normalizeTokenUsage(context.tokenUsage),
    parsePosition: normalizeNumber(context.parsePosition),
    jsonSnippet: capString(context.jsonSnippet, MAX_JSON_SNIPPET_CHARS),
    rawOutputExcerpt: capString(context.rawOutputExcerpt, MAX_RAW_OUTPUT_EXCERPT_CHARS),
  };
  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined && value !== ""),
  ) as ErrorTechnicalContext;
}

function normalizeTokenUsage(tokenUsage?: TokenUsage): TokenUsage | undefined {
  if (!tokenUsage) return undefined;
  const input = normalizeNumber(tokenUsage.input);
  const output = normalizeNumber(tokenUsage.output);
  const total = normalizeNumber(tokenUsage.total);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { input, output, total };
}

function normalizeNumber(value?: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function capString(value: string | undefined, maxLength: number) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
