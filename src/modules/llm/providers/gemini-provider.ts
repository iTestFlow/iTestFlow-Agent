import "server-only";

import { z } from "zod";
import { DEFAULT_TEXT_OUTPUT_TOKENS, DEFAULT_RETRY_ATTEMPTS } from "../llm-defaults";
import { withStructuredOutputInstruction } from "../prompts";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import { fetchWithTransientRetry } from "./fetch-with-transient-retry";
import type { GenerateStructuredOutputInput, GenerateTextInput, GenerateToolCallInput } from "../llm-types";

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
        maxOutputTokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
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
      signal: input.signal,
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
      tokenUsage: geminiTokenUsage(json.usageMetadata),
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Gemini API key is not configured.");
    const baseUrl = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const requestBody = {
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
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
      signal: input.signal,
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
      tokenUsage: geminiTokenUsage(json.usageMetadata),
    };
  }

  protected async callToolModel(input: GenerateToolCallInput): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Gemini API key is not configured.");
    const baseUrl = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const requestBody = {
      generationConfig: { maxOutputTokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS, ...geminiStructuredOutputOptions(this.model) },
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.user }] }],
      tools: [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    };
    const response = await fetchWithTransientRetry(
      `${baseUrl}/models/${this.model}:generateContent?key=${this.config.apiKey}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(requestBody), signal: input.signal },
      this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
    );
    if (!response.ok) {
      const errorText = await response.text();
      return { rawOutput: "", requestBody, responseBody: errorText, errorMessage: `Gemini request failed: ${errorText}` };
    }
    const json = await response.json();
    const parts = json?.candidates?.[0]?.content?.parts;
    const calls = Array.isArray(parts) ? parts.filter((part) => part?.functionCall) : [];
    if (calls.length !== 1) {
      return { rawOutput: JSON.stringify(json), requestBody, responseBody: json, errorMessage: "response must contain exactly one functionCall." };
    }
    const call = calls[0].functionCall;
    if (typeof call?.name !== "string" || !call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
      return { rawOutput: JSON.stringify(json), requestBody, responseBody: json, errorMessage: "functionCall is malformed." };
    }
    return { rawOutput: JSON.stringify(json), requestBody, responseBody: json, finishReason: json?.candidates?.[0]?.finishReason, tokenUsage: geminiTokenUsage(json?.usageMetadata), toolCall: { name: call.name, arguments: call.args } };
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

function geminiTokenUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const input = optionalCount(value.promptTokenCount);
  const total = optionalCount(value.totalTokenCount);
  const candidateOutput = optionalCount(value.candidatesTokenCount);
  const output = total !== undefined && input !== undefined
    ? Math.max(0, total - input)
    : candidateOutput;

  return { input, output, total };
}

function optionalCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
