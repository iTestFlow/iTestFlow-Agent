import "server-only";

import { z } from "zod";
import { DEFAULT_MAX_TOKENS, DEFAULT_RETRY_ATTEMPTS } from "../llm-defaults";
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
      max_tokens: input.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    };
    const response = await this.requestChatCompletion(requestBody);

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
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("OpenAI API key is not configured.");
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: withStructuredOutputInstruction(input.system, input.schemaName) },
        { role: "user", content: input.user },
      ],
    };
    const response = await this.requestChatCompletion(requestBody);

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
    };
  }

  private buildCompatibleBody(requestBody: Record<string, unknown>) {
    return this.maxTokensRenamed ? withMaxCompletionTokens(requestBody) : requestBody;
  }

  private async requestChatCompletion(requestBody: Record<string, unknown>): Promise<Response> {
    const url = `${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
    const headers = {
      ...this.headers(),
      Authorization: `Bearer ${this.config.apiKey as string}`,
    };
    const retryAttempts = this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    const body = this.buildCompatibleBody(requestBody);

    const response = await fetchWithTransientRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
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
        { method: "POST", headers, body: JSON.stringify(withMaxCompletionTokens(body)) },
        retryAttempts,
      );
    }

    return response;
  }
}
