import "server-only";

import { z } from "zod";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { JsonParseError, parseJsonWithRepair } from "../json-extraction";
import { addTokenUsage, hasTokenUsage } from "../token-usage";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  DEFAULT_TEXT_OUTPUT_TOKENS,
} from "../llm-defaults";
import { writeLLMRequestLog } from "../llm-request-log.service";
import type {
  GenerateStructuredOutputInput,
  GenerateTextInput,
  LLMProvider,
  LLMProviderConfig,
  LLMProviderName,
  LLMResult,
  LLMTextResult,
  TokenUsage,
} from "../llm-types";

export type LLMProviderCallResult = {
  rawOutput: string;
  requestBody?: unknown;
  responseBody?: unknown;
  errorMessage?: string;
  finishReason?: string;
  tokenUsage?: TokenUsage;
};

export abstract class BaseJsonProvider implements LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  protected readonly config: LLMProviderConfig;
  private cumulativeTokenUsage: TokenUsage | undefined;
  private cumulativeTokenUsageComplete = true;

  constructor(config: LLMProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.config = config;
  }

  abstract testConnection(): Promise<boolean>;

  getTokenUsage(): TokenUsage | undefined {
    return this.cumulativeTokenUsageComplete && this.cumulativeTokenUsage
      ? { ...this.cumulativeTokenUsage }
      : undefined;
  }

  async generateText(input: GenerateTextInput): Promise<LLMTextResult> {
    const startedAt = Date.now();
    let callResult: LLMProviderCallResult | null = null;

    try {
      callResult = await this.callTextModel(input);
      this.recordTokenUsage(callResult.tokenUsage);
      if (callResult.errorMessage) {
        throw this.providerError(callResult.errorMessage, {
          schemaName: "PlainText",
          rawOutput: callResult.rawOutput,
          finishReason: callResult.finishReason,
          tokenUsage: callResult.tokenUsage,
        });
      }

      this.logTextRequest(input, callResult, "Success", Date.now() - startedAt);

      return {
        provider: this.name,
        model: this.model,
        rawOutput: callResult.rawOutput,
        text: callResult.rawOutput.trim(),
        tokenUsage: hasTokenUsage(callResult.tokenUsage) ? callResult.tokenUsage : undefined,
        warnings: buildTruncationWarnings(callResult.finishReason, input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS),
      };
    } catch (error) {
      const normalizedError = this.normalizeProviderThrownError(error, {
        schemaName: "PlainText",
        rawOutput: callResult?.rawOutput,
        finishReason: callResult?.finishReason,
        tokenUsage: callResult?.tokenUsage,
      });
      const message = normalizedError instanceof Error ? normalizedError.message : "Unknown LLM text request error.";
      this.logTextRequest(input, callResult, "Failed", Date.now() - startedAt, message);
      throw normalizedError;
    }
  }

  async generateStructuredOutput<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
  ): Promise<LLMResult<z.infer<TSchema>>> {
    const startedAt = Date.now();
    let callResult: LLMProviderCallResult | null = null;
    // max_tokens is a CEILING, not a reservation: the provider spends latency and cost only on
    // tokens it actually generates, so we request the full output-token cap in a single call.
    // An explicit input.maxTokens is honored as an OPTIONAL lower ceiling for callers that
    // deliberately want to bound output length.
    const cap = positiveIntegerOrDefault(this.config.maxOutputTokenCap, DEFAULT_MAX_OUTPUT_TOKEN_CAP);
    const budget = Math.min(positiveIntegerOrDefault(input.maxTokens, cap), cap);

    try {
      callResult = await this.callModel({ ...input, maxTokens: budget });
      this.recordTokenUsage(callResult.tokenUsage);
      if (callResult.errorMessage) {
        throw this.providerError(callResult.errorMessage, {
          schemaName: input.schemaName,
          rawOutput: callResult.rawOutput,
          finishReason: callResult.finishReason,
          tokenUsage: callResult.tokenUsage,
        });
      }

      const validatedOutput = this.parseAndValidate(input, callResult.rawOutput, callResult.finishReason, callResult.tokenUsage);
      // Parse succeeded but the model still stopped on a token limit: the JSON is valid yet may be
      // semantically cut short (e.g. fewer test cases than intended). Surface a non-blocking warning.
      const warnings = buildTruncationWarnings(callResult.finishReason, budget);
      this.logRequest(input, callResult, "Success", Date.now() - startedAt, undefined, validatedOutput);

      return {
        provider: this.name,
        model: this.model,
        rawOutput: callResult.rawOutput,
        validatedOutput,
        tokenUsage: hasTokenUsage(callResult.tokenUsage) ? callResult.tokenUsage : undefined,
        warnings,
      };
    } catch (error) {
      const normalizedError = this.normalizeProviderThrownError(error, {
        schemaName: input.schemaName,
        rawOutput: callResult?.rawOutput,
        finishReason: callResult?.finishReason,
        tokenUsage: callResult?.tokenUsage,
      });
      const message = normalizedError instanceof Error ? normalizedError.message : "Unknown LLM request error.";
      this.logRequest(input, callResult, "Failed", Date.now() - startedAt, message);
      throw normalizedError;
    }
  }

  protected abstract callTextModel(input: GenerateTextInput): Promise<LLMProviderCallResult>;

  protected abstract callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult>;

  private parseAndValidate<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
    rawOutput: string,
    finishReason?: string,
    tokenUsage?: TokenUsage,
  ): z.infer<TSchema> {
    let parsedJson: unknown;

    try {
      parsedJson = this.parseJson(rawOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
      const tokenLimit = isTokenLimitFinishReason(finishReason);
      const truncated = tokenLimit
        ? ' The provider stopped because it hit the output-token limit before completing the JSON. Increase the "Maximum output token cap" in Settings and retry.'
        : "";
      throw new AppError({
        code: tokenLimit ? AppErrorCode.TokenLimit : AppErrorCode.InvalidJson,
        message: `LLM output for ${input.schemaName} was not valid JSON:${truncated} ${message}`,
        userMessage: tokenLimit
          ? 'The AI response ran out of output space before it finished. Increase the "Maximum output token cap" in Settings and retry.'
          : "The AI response was not valid JSON. Please retry the generation.",
        technicalContext: {
          provider: this.name,
          model: this.model,
          schemaName: input.schemaName,
          finishReason,
          tokenUsage,
          parsePosition: error instanceof JsonParseError ? error.position : undefined,
          jsonSnippet: error instanceof JsonParseError ? error.snippet : undefined,
          rawOutputExcerpt: rawOutput,
        },
      });
    }

    const result = input.schema.safeParse(stripNullProperties(parsedJson));
    if (!result.success) {
      throw new AppError({
        code: AppErrorCode.SchemaValidation,
        message: `LLM output failed schema validation for ${input.schemaName}: ${result.error.message}`,
        userMessage: "The AI returned a response that did not match the expected format. Please retry or adjust the input.",
        technicalContext: {
          provider: this.name,
          model: this.model,
          schemaName: input.schemaName,
          finishReason,
          tokenUsage,
          rawOutputExcerpt: rawOutput,
        },
      });
    }

    return result.data;
  }

  protected parseJson(rawOutput: string) {
    return parseJsonWithRepair(rawOutput);
  }

  protected headers() {
    return {
      "Content-Type": "application/json",
    };
  }

  private recordTokenUsage(tokenUsage?: TokenUsage) {
    if (!hasTokenUsage(tokenUsage)) {
      this.cumulativeTokenUsageComplete = false;
      return;
    }
    this.cumulativeTokenUsage = addTokenUsage(this.cumulativeTokenUsage, tokenUsage);
  }

  private logRequest<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
    callResult: LLMProviderCallResult | null,
    status: "Success" | "Failed",
    durationMs: number,
    errorDetails?: string,
    validatedOutput?: z.infer<TSchema>,
  ) {
    try {
      writeLLMRequestLog({
        ...input.metadata,
        provider: this.name,
        model: this.model,
        schemaName: input.schemaName,
        systemPrompt: input.system,
        userPrompt: input.user,
        requestBody: callResult?.requestBody,
        responseBody: callResult?.responseBody,
        rawOutput: callResult?.rawOutput,
        validatedOutput,
        status,
        errorDetails,
        durationMs,
      });
    } catch (logError) {
      console.error("Failed to write LLM request log", logError);
    }
  }

  private logTextRequest(
    input: GenerateTextInput,
    callResult: LLMProviderCallResult | null,
    status: "Success" | "Failed",
    durationMs: number,
    errorDetails?: string,
  ) {
    try {
      writeLLMRequestLog({
        ...input.metadata,
        provider: this.name,
        model: this.model,
        schemaName: "PlainText",
        systemPrompt: input.system,
        userPrompt: input.user,
        requestBody: callResult?.requestBody,
        responseBody: callResult?.responseBody,
        rawOutput: callResult?.rawOutput,
        validatedOutput: undefined,
        status,
        errorDetails,
        durationMs,
      });
    } catch (logError) {
      console.error("Failed to write LLM text request log", logError);
    }
  }

  private providerError(
    message: string,
    context: {
      schemaName: string;
      rawOutput?: string;
      finishReason?: string;
      tokenUsage?: TokenUsage;
    },
  ) {
    return new AppError({
      code: isLikelyNetworkError(message) ? AppErrorCode.Network : AppErrorCode.ProviderUnavailable,
      message,
      userMessage: isLikelyNetworkError(message)
        ? "Network error. Check your connection and try again."
        : "The AI provider could not complete the request. Please try again in a moment or check the provider settings.",
      technicalContext: {
        provider: this.name,
        model: this.model,
        schemaName: context.schemaName,
        finishReason: context.finishReason,
        tokenUsage: context.tokenUsage,
        rawOutputExcerpt: context.rawOutput,
      },
    });
  }

  private normalizeProviderThrownError(
    error: unknown,
    context: {
      schemaName: string;
      rawOutput?: string;
      finishReason?: string;
      tokenUsage?: TokenUsage;
    },
  ) {
    if (error instanceof AppError) return error;
    const message = error instanceof Error ? error.message : "Unknown LLM request error.";
    return this.providerError(message, context);
  }
}

function isLikelyNetworkError(message: string) {
  return /failed to fetch|network\s*error|fetch failed|econnreset|etimedout|enotfound|eai_again/i.test(message);
}

function isTokenLimitFinishReason(finishReason?: string) {
  const normalized = finishReason?.toLowerCase();
  return normalized === "length" || normalized === "max_tokens";
}

// When the model stopped because it hit the output-token limit, return a user-facing warning so
// the caller can surface "raise the cap" guidance. Returns undefined when the response finished
// cleanly, so callers can leave `warnings` unset in the common case.
function buildTruncationWarnings(finishReason: string | undefined, limit: number): string[] | undefined {
  if (!isTokenLimitFinishReason(finishReason)) return undefined;
  return [
    `Output was truncated at the ${limit.toLocaleString()}-token output limit, so the result may be incomplete. Increase the "Maximum output token cap" in Settings and re-run if the output looks cut off.`,
  ];
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

// Models routinely emit `null` for optional fields (e.g. an initial state's `fromState`).
// Zod's `.optional()` accepts `undefined`/missing but rejects `null`, so drop null-valued object
// properties before validation: an optional field becomes "absent" (accepted), while a required
// field becomes "missing" (still fails, as it should). No LLM-output schema relies on null.
function stripNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullProperties);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== null)
        .map(([key, entry]) => [key, stripNullProperties(entry)]),
    );
  }
  return value;
}
