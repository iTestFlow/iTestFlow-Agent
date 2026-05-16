import "server-only";

import { z } from "zod";
import { withStructuredOutputInstruction } from "../prompts";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
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
        temperature: input.temperature ?? this.config.temperature ?? 0.2,
        maxOutputTokens: input.maxTokens ?? this.config.maxTokens ?? 4000,
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
      this.config.retryAttempts ?? 1,
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
        temperature: input.temperature ?? this.config.temperature ?? 0.2,
        maxOutputTokens: input.maxTokens ?? this.config.maxTokens ?? 4000,
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
      this.config.retryAttempts ?? 1,
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

async function fetchWithTransientRetry(url: string, init: RequestInit, retryAttempts: number) {
  let response = await fetch(url, init);
  for (let attempt = 0; attempt < retryAttempts && isTransientGeminiFailure(response); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    response = await fetch(url, init);
  }
  return response;
}

function isTransientGeminiFailure(response: Response) {
  return response.status === 429 || response.status === 503;
}
