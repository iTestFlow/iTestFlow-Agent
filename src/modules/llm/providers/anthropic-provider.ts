import "server-only";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DEFAULT_TEXT_OUTPUT_TOKENS, DEFAULT_RETRY_ATTEMPTS } from "../llm-defaults";
import { withStructuredOutputInstruction } from "../prompts";
import { normalizeProviderBaseUrl } from "../provider-base-url";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import { fetchWithTransientRetry } from "./fetch-with-transient-retry";
import type { GenerateStructuredOutputInput, GenerateTextInput } from "../llm-types";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export class AnthropicProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    if (!this.config.apiKey || !this.config.model) return false;
    const response = await fetch(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Return ok." }],
      }),
    });
    return response.ok;
  }

  protected async callTextModel(input: GenerateTextInput): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Anthropic API key is not configured.");
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    };
    const response = await fetchWithTransientRetry(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    }, this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "",
        requestBody,
        responseBody: errorText,
        errorMessage: `Anthropic request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    const rawOutput = anthropicTextContent(json.content);
    return {
      rawOutput,
      requestBody,
      responseBody: json,
      errorMessage: rawOutput.trim() ? undefined : noTextContentError(json.content),
      userMessage: rawOutput.trim()
        ? undefined
        : "Claude returned no final text response. Please retry; if this repeats, choose another model.",
      finishReason: json.stop_reason,
      tokenUsage: anthropicTokenUsage(json.usage),
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Anthropic API key is not configured.");
    const outputConfig = supportsNativeStructuredOutput(this.model)
      ? {
          format: {
            type: "json_schema",
            schema: anthropicJsonSchema(input.schema),
          },
        }
      : undefined;
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
      system: withStructuredOutputInstruction(input.system, input.schemaName),
      messages: [{ role: "user", content: input.user }],
      ...(outputConfig ? { output_config: outputConfig } : {}),
    };
    const response = await fetchWithTransientRetry(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    }, this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "{}",
        requestBody,
        responseBody: errorText,
        errorMessage: `Anthropic request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    const rawOutput = anthropicTextContent(json.content);
    return {
      rawOutput,
      requestBody,
      responseBody: json,
      errorMessage: rawOutput.trim() ? undefined : noTextContentError(json.content),
      userMessage: rawOutput.trim()
        ? undefined
        : "Claude completed the request without a final JSON response. Please retry; if this repeats, choose another model.",
      finishReason: json.stop_reason,
      tokenUsage: anthropicTokenUsage(json.usage),
    };
  }

  private baseUrl() {
    return normalizeProviderBaseUrl(this.config.baseUrl, ANTHROPIC_DEFAULT_BASE_URL, { requiredPath: "/v1" });
  }
}

const UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "format",
]);

function supportsNativeStructuredOutput(model: string) {
  const normalized = model.toLowerCase();
  return normalized.includes("claude-sonnet-5") || normalized.includes("claude-fable-5");
}

function anthropicJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  });
  return sanitizeAnthropicJsonSchema(jsonSchema) as Record<string, unknown>;
}

function sanitizeAnthropicJsonSchema(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeAnthropicJsonSchema(entry));
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const sanitized = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => propertyMap || (key !== "$schema" && !UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS.has(key)))
      .map(([key, entry]) => [
        key,
        sanitizeAnthropicJsonSchema(entry, !propertyMap && key === "properties"),
      ]),
  );
  if (sanitized.type === "object" || sanitized.properties) {
    sanitized.additionalProperties = false;
  }
  return sanitized;
}

function anthropicTextContent(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === undefined || block.type === "text")
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function noTextContentError(content: unknown) {
  if (!Array.isArray(content)) {
    return "Anthropic response did not contain a content-block array.";
  }
  const blockTypes = content
    .map((block) => {
      if (!block || typeof block !== "object") return "unknown";
      const type = (block as Record<string, unknown>).type;
      return typeof type === "string" && type.trim() ? type : "unknown";
    });
  return `Anthropic response contained no text content block. Content block types: ${blockTypes.join(", ") || "none"}.`;
}

function anthropicTokenUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const inputParts = [
    optionalCount(value.input_tokens),
    optionalCount(value.cache_creation_input_tokens),
    optionalCount(value.cache_read_input_tokens),
  ];
  const input = inputParts.some((count) => count !== undefined)
    ? inputParts.reduce<number>((total, count) => total + (count ?? 0), 0)
    : undefined;
  const output = optionalCount(value.output_tokens);
  return {
    input,
    output,
    total: input !== undefined && output !== undefined ? input + output : undefined,
  };
}

function optionalCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
