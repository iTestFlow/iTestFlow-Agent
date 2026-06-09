import "server-only";

import { z } from "zod";
import { parseJsonWithRepair } from "../json-extraction";
import { addTokenUsage, hasTokenUsage } from "../token-usage";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  DEFAULT_MAX_TRUNCATION_ATTEMPTS,
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
      if (callResult.errorMessage) throw new Error(callResult.errorMessage);

      this.logTextRequest(input, callResult, "Success", Date.now() - startedAt);

      return {
        provider: this.name,
        model: this.model,
        rawOutput: callResult.rawOutput,
        text: callResult.rawOutput.trim(),
        tokenUsage: hasTokenUsage(callResult.tokenUsage) ? callResult.tokenUsage : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown LLM text request error.";
      this.logTextRequest(input, callResult, "Failed", Date.now() - startedAt, message);
      throw error;
    }
  }

  async generateStructuredOutput<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
  ): Promise<LLMResult<z.infer<TSchema>>> {
    const startedAt = Date.now();
    let callResult: LLMProviderCallResult | null = null;
    // max_tokens is a CEILING, not a reservation: providers spend latency and cost only on
    // tokens actually generated. Starting low and doubling on truncation regenerates the whole
    // response from scratch each time, so we request the full cap on the first attempt — the
    // common case then completes in a single pass. An explicit input.maxTokens is still honored
    // as an OPTIONAL lower ceiling for callers that deliberately want to bound output length.
    const cap = positiveIntegerOrDefault(this.config.maxOutputTokenCap, DEFAULT_MAX_OUTPUT_TOKEN_CAP);
    const requestedCeiling = positiveIntegerOrDefault(input.maxTokens, cap);
    const startingBudget = Math.min(requestedCeiling, cap);
    const maxTruncationAttempts = positiveIntegerOrDefault(
      this.config.maxTruncationAttempts,
      DEFAULT_MAX_TRUNCATION_ATTEMPTS,
    );
    let budget = startingBudget;
    let operationTokenUsage: TokenUsage | undefined;
    let operationTokenUsageComplete = true;

    try {
      for (let attempt = 0; attempt < maxTruncationAttempts; attempt += 1) {
        const attemptInput = { ...input, maxTokens: budget };
        let attemptResult: LLMProviderCallResult;

        try {
          attemptResult = await this.callModel(attemptInput);
          if (!hasTokenUsage(attemptResult.tokenUsage)) operationTokenUsageComplete = false;
          operationTokenUsage = addTokenUsage(operationTokenUsage, attemptResult.tokenUsage);
          this.recordTokenUsage(attemptResult.tokenUsage);
        } catch (callError) {
          if (callResult && isTokenLimitFinishReason(callResult.finishReason)) break;
          throw callError;
        }

        if (attemptResult.errorMessage) {
          if (callResult && isTokenLimitFinishReason(callResult.finishReason)) break;
          callResult = attemptResult;
          throw new Error(attemptResult.errorMessage);
        }

        callResult = attemptResult;
        if (!isTokenLimitFinishReason(callResult.finishReason)) break;
        if (budget >= cap || attempt === maxTruncationAttempts - 1) break;

        const nextBudget = Math.min(budget * 2, cap);
        if (nextBudget <= budget) break;
        budget = nextBudget;
      }

      if (!callResult) throw new Error("LLM provider returned no result.");
      const validatedOutput = this.parseAndValidate(input, callResult.rawOutput, callResult.finishReason);
      this.logRequest(input, callResult, "Success", Date.now() - startedAt, undefined, validatedOutput);

      return {
        provider: this.name,
        model: this.model,
        rawOutput: callResult.rawOutput,
        validatedOutput,
        tokenUsage: operationTokenUsageComplete ? operationTokenUsage : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown LLM request error.";
      this.logRequest(input, callResult, "Failed", Date.now() - startedAt, message);
      throw error;
    }
  }

  protected abstract callTextModel(input: GenerateTextInput): Promise<LLMProviderCallResult>;

  protected abstract callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult>;

  private parseAndValidate<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
    rawOutput: string,
    finishReason?: string,
  ): z.infer<TSchema> {
    let parsedJson: unknown;

    try {
      parsedJson = this.parseJson(rawOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
      const truncated = isTokenLimitFinishReason(finishReason)
        ? " The provider stopped because it exhausted the max output token budget before completing the JSON."
        : "";
      throw new Error(`LLM output for ${input.schemaName} was not valid JSON:${truncated} ${message}`);
    }

    const result = input.schema.safeParse(stripNullProperties(parsedJson));
    if (!result.success) {
      throw new Error(`LLM output failed schema validation for ${input.schemaName}: ${result.error.message}`);
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
}

function isTokenLimitFinishReason(finishReason?: string) {
  const normalized = finishReason?.toLowerCase();
  return normalized === "length" || normalized === "max_tokens";
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
