import "server-only";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DEFAULT_TEXT_OUTPUT_TOKENS, DEFAULT_RETRY_ATTEMPTS } from "../llm-defaults";
import { withStructuredOutputInstruction } from "../prompts";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import { fetchWithTransientRetry } from "./fetch-with-transient-retry";
import { isMaxTokensRenameError, withMaxCompletionTokens } from "./provider-param-compat";
import type { GenerateStructuredOutputInput, GenerateTextInput } from "../llm-types";

export class OpenAIProvider extends BaseJsonProvider {
  // GPT-5 / o-series reasoning models require `max_completion_tokens` instead of `max_tokens`.
  // Detect that 400 once and self-correct for the rest of this provider instance's lifetime, so
  // newer models work without a per-model allow-list while GPT-4o/4.1-class models keep `max_tokens`.
  private maxTokensRenamed = false;

  async testConnection(): Promise<boolean> {
    if (!this.config.apiKey || !this.config.model) return false;
    const response = await fetch(`${this.config.baseUrl ?? "https://api.openai.com/v1"}/models/${this.model}`, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });
    return response.ok;
  }

  protected async callTextModel(input: GenerateTextInput): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("OpenAI API key is not configured.");
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    };
    const response = await this.requestChatCompletion(requestBody, input.signal);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "",
        requestBody,
        responseBody: errorText,
        errorMessage: `OpenAI request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    return {
      rawOutput: json.choices?.[0]?.message?.content ?? "",
      requestBody,
      responseBody: json,
      finishReason: json.choices?.[0]?.finish_reason,
      tokenUsage: openAITokenUsage(json.usage),
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("OpenAI API key is not configured.");
    const messages = [
      { role: "system", content: withStructuredOutputInstruction(input.system, input.schemaName) },
      { role: "user", content: input.user },
    ];
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: input.schemaName,
          schema: openaiJsonSchema(input.schema),
          strict: true,
        },
      },
      messages,
    };
    const response = await this.requestChatCompletion(requestBody, input.signal);

    if (!response.ok) {
      const errorText = await response.text();
      if (isOpenAIJsonSchemaFallbackError(errorText)) {
        const fallbackRequestBody = {
          model: this.model,
          max_tokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
          response_format: { type: "json_object" },
          messages,
        };
        const fallbackResponse = await this.requestChatCompletion(fallbackRequestBody, input.signal);
        return openAIStructuredCallResult(fallbackResponse, fallbackRequestBody);
      }
      return {
        rawOutput: "{}",
        requestBody,
        responseBody: errorText,
        errorMessage: `OpenAI request failed: ${errorText}`,
      };
    }
    return openAIStructuredCallResult(response, requestBody);
  }

  private buildCompatibleBody(requestBody: Record<string, unknown>) {
    return this.maxTokensRenamed ? withMaxCompletionTokens(requestBody) : requestBody;
  }

  private async requestChatCompletion(requestBody: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const url = `${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
    const headers = {
      ...this.headers(),
      Authorization: `Bearer ${this.config.apiKey as string}`,
    };
    const retryAttempts = this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    const body = this.buildCompatibleBody(requestBody);

    const response = await fetchWithTransientRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body), signal },
      retryAttempts,
    );

    // GPT-5 / o-series reject `max_tokens` and require `max_completion_tokens`. Rename and retry
    // once on that 400, then remember it so later calls send the right field up front.
    if (response.status === 400 && !this.maxTokensRenamed && "max_tokens" in body) {
      const errorText = await response.text();
      if (!isMaxTokensRenameError(errorText)) {
        // Unrelated 400 — hand the already-consumed body back to the caller.
        return new Response(errorText, { status: 400 });
      }
      this.maxTokensRenamed = true;
      return fetchWithTransientRetry(
        url,
        { method: "POST", headers, body: JSON.stringify(withMaxCompletionTokens(body)), signal },
        retryAttempts,
      );
    }

    return response;
  }
}

async function openAIStructuredCallResult(
  response: Response,
  requestBody: Record<string, unknown>,
): Promise<LLMProviderCallResult> {
  if (!response.ok) {
    const errorText = await response.text();
    return {
      rawOutput: "{}",
      requestBody,
      responseBody: errorText,
      errorMessage: `OpenAI request failed: ${errorText}`,
    };
  }
  const json = await response.json();
  return {
    rawOutput: json.choices?.[0]?.message?.content ?? "{}",
    requestBody,
    responseBody: json,
    finishReason: json.choices?.[0]?.finish_reason,
    tokenUsage: openAITokenUsage(json.usage),
  };
}

function isOpenAIJsonSchemaFallbackError(errorText: string) {
  return /json_schema|response_format|invalid schema/i.test(errorText);
}

function unwrapZodEffects(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    const def = current._def as { typeName?: string; schema?: z.ZodTypeAny };
    if (def.typeName !== "ZodEffects" || !def.schema) return current;
    current = def.schema;
  }
}

function openaiJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(unwrapZodEffects(schema), {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  delete jsonSchema.definitions;
  delete jsonSchema.$defs;
  return jsonSchema;
}

function openAITokenUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  return {
    input: optionalCount(value.prompt_tokens),
    output: optionalCount(value.completion_tokens),
    total: optionalCount(value.total_tokens),
  };
}

function optionalCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
