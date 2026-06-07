import "server-only";

import { z } from "zod";
import { DEFAULT_MAX_TOKENS, DEFAULT_RETRY_ATTEMPTS } from "../llm-defaults";
import { withStructuredOutputInstruction } from "../prompts";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import { fetchWithTransientRetry } from "./fetch-with-transient-retry";
import type { GenerateStructuredOutputInput, GenerateTextInput } from "../llm-types";

export class GeminiProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    if (!this.config.apiKey || !this.config.model) return false;
    const baseUrl = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const response = await fetch(`${baseUrl}/models/${this.model}?key=${this.config.apiKey}`);
    return response.ok;
  }

  protected async callTextModel(input: GenerateTextInput): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Gemini API key is not configured.");
    const baseUrl = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const requestBody = {
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...geminiStructuredOutputOptions(this.model),
      },
      systemInstruction: {
        parts: [{ text: input.system }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: input.user }],
        },
      ],
    };
    const request = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(requestBody),
    };
    const response = await fetchWithTransientRetry(
      `${baseUrl}/models/${this.model}:generateContent?key=${this.config.apiKey}`,
      request,
      this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "",
        requestBody,
        responseBody: errorText,
        errorMessage: `Gemini request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    return {
      rawOutput: json.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      requestBody,
      responseBody: json,
      finishReason: json.candidates?.[0]?.finishReason,
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Gemini API key is not configured.");
    const baseUrl = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const requestBody = {
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
        responseMimeType: "application/json",
        ...geminiStructuredOutputOptions(this.model),
      },
      systemInstruction: {
        parts: [{ text: withStructuredOutputInstruction(input.system, input.schemaName) }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: input.user }],
        },
      ],
    };
    const request = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(requestBody),
    };
    const response = await fetchWithTransientRetry(
      `${baseUrl}/models/${this.model}:generateContent?key=${this.config.apiKey}`,
      request,
      this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "{}",
        requestBody,
        responseBody: errorText,
        errorMessage: `Gemini request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    return {
      rawOutput: json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}",
      requestBody,
      responseBody: json,
      finishReason: json.candidates?.[0]?.finishReason,
    };
  }
}

function geminiStructuredOutputOptions(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gemini-2.5-flash")) {
    return {
      thinkingConfig: {
        thinkingBudget: 0,
      },
    };
  }

  return {};
}
