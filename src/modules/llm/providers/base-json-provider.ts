import "server-only";

import { z } from "zod";
import { parseJsonWithRepair } from "../json-extraction";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  DEFAULT_MAX_TOKENS,
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
} from "../llm-types";

export type LLMProviderCallResult = {
  rawOutput: string;
  requestBody?: unknown;
  responseBody?: unknown;
  errorMessage?: string;
  finishReason?: string;
};

export abstract class BaseJsonProvider implements LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  protected readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.config = config;
  }

  abstract testConnection(): Promise<boolean>;

  async generateText(input: GenerateTextInput): Promise<LLMTextResult> {
    const startedAt = Date.now();
    let callResult: LLMProviderCallResult | null = null;

    try {
      callResult = await this.callTextModel(input);
      if (callResult.errorMessage) throw new Error(callResult.errorMessage);

      this.logTextRequest(input, callResult, "Success", Date.now() - startedAt);

      return {
        provider: this.name,
        model: this.model,
        rawOutput: callResult.rawOutput,
        text: callResult.rawOutput.trim(),
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
    const cap = positiveIntegerOrDefault(this.config.maxOutputTokenCap, DEFAULT_MAX_OUTPUT_TOKEN_CAP);
    const startingBudget = Math.min(
      positiveIntegerOrDefault(input.maxTokens ?? this.config.maxTokens, DEFAULT_MAX_TOKENS),
      cap,
    );
    const maxTruncationAttempts = positiveIntegerOrDefault(
      this.config.maxTruncationAttempts,
      DEFAULT_MAX_TRUNCATION_ATTEMPTS,
    );
    let budget = startingBudget;

    try {
      for (let attempt = 0; attempt < maxTruncationAttempts; attempt += 1) {
        const attemptInput = { ...input, maxTokens: budget };
        let attemptResult: LLMProviderCallResult;

        try {
          attemptResult = await this.callModel(attemptInput);
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

    const result = input.schema.safeParse(parsedJson);
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
