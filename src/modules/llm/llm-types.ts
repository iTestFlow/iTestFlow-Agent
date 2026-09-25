import { z } from "zod";
import type { LLMRequestLogMetadata } from "./llm-request-log.service";

export type LLMProviderName = "openai" | "gemini" | "anthropic";

export type LLMProviderConfig = {
  provider: LLMProviderName;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  maxOutputTokenCap?: number;
  maxInputTokens?: number;
  retryAttempts?: number;
};

export type LLMImageMediaType = "image/png" | "image/jpeg" | "image/webp";

// Base64 is kept separate from its MIME type so providers can safely build their
// own native image parts without accepting an arbitrary URL or data URL.
export type LLMImageInput = {
  mediaType: LLMImageMediaType;
  data: string;
};

// Keep inline images within the lowest direct-provider request limit: Anthropic
// accepts 10 MiB base64 image payloads and a 32 MiB request body. The combined
// cap leaves room for prompts and provider-specific request envelopes.
export const MAX_LLM_IMAGE_INPUT_COUNT = 20;
export const MAX_LLM_IMAGE_INPUT_BASE64_BYTES = 10 * 1024 * 1024;
export const MAX_LLM_IMAGE_INPUT_TOTAL_BASE64_BYTES = 20 * 1024 * 1024;

const LLM_IMAGE_MEDIA_TYPES = new Set<LLMImageMediaType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const BASE64_CHARACTERS_PATTERN = /^[A-Za-z0-9+/]*$/;
export const REDACTED_LLM_IMAGE_DATA = "[REDACTED_IMAGE_DATA]";

export function validateLLMImageInputs(images?: readonly LLMImageInput[]): readonly LLMImageInput[] | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) throw new Error("LLM image inputs must be an array.");
  if (images.length > MAX_LLM_IMAGE_INPUT_COUNT) {
    throw new Error(`LLM requests support at most ${MAX_LLM_IMAGE_INPUT_COUNT} inline images.`);
  }

  let totalBase64Bytes = 0;
  for (const image of images) {
    const value = image as { mediaType?: unknown; data?: unknown };
    if (!value || typeof value !== "object" || !isLLMImageMediaType(value.mediaType)) {
      throw new Error("LLM image inputs must use image/png, image/jpeg, or image/webp.");
    }
    if (typeof value.data !== "string" || !isCanonicalBase64(value.data)) {
      throw new Error("LLM image input data must be non-empty canonical base64.");
    }
    if (value.data.length > MAX_LLM_IMAGE_INPUT_BASE64_BYTES) {
      throw new Error(`Each inline LLM image may contain at most ${formatMiB(MAX_LLM_IMAGE_INPUT_BASE64_BYTES)} MiB of base64 data.`);
    }
    totalBase64Bytes += value.data.length;
    if (totalBase64Bytes > MAX_LLM_IMAGE_INPUT_TOTAL_BASE64_BYTES) {
      throw new Error(`Combined inline LLM image base64 data exceeds ${formatMiB(MAX_LLM_IMAGE_INPUT_TOTAL_BASE64_BYTES)} MiB.`);
    }
  }

  return images;
}

export function toLLMImageDataUrl(image: LLMImageInput) {
  return `data:${image.mediaType};base64,${image.data}`;
}

// Provider request bodies are kept in LLM request logs for diagnostics. Replace
// only image data fields, preserving the surrounding payload shape for support.
export function redactLLMImagePayload<T>(payload: T): T {
  return redactImagePayload(payload) as T;
}

function redactImagePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactImagePayload);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  if (source.type === "base64" && isLLMImageMediaType(source.media_type) && typeof source.data === "string") {
    return { ...source, data: REDACTED_LLM_IMAGE_DATA };
  }

  if (source.type === "image_url" && isRecord(source.image_url) && typeof source.image_url.url === "string"
    && source.image_url.url.startsWith("data:image/")) {
    return { ...source, image_url: { ...source.image_url, url: REDACTED_LLM_IMAGE_DATA } };
  }

  if (isRecord(source.inlineData) && isLLMImageMediaType(source.inlineData.mimeType) && typeof source.inlineData.data === "string") {
    return { ...source, inlineData: { ...source.inlineData, data: REDACTED_LLM_IMAGE_DATA } };
  }

  return Object.fromEntries(Object.entries(source).map(([key, entry]) => [key, redactImagePayload(entry)]));
}

function isLLMImageMediaType(value: unknown): value is LLMImageMediaType {
  return typeof value === "string" && LLM_IMAGE_MEDIA_TYPES.has(value as LLMImageMediaType);
}

function isCanonicalBase64(value: string) {
  if (!value || value.length % 4 !== 0) return false;
  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const data = value.slice(0, value.length - paddingLength);
  return BASE64_CHARACTERS_PATTERN.test(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatMiB(value: number) {
  return Math.floor(value / (1024 * 1024)).toLocaleString();
}

export type GenerateStructuredOutputInput<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  system: string;
  user: string;
  images?: readonly LLMImageInput[];
  schema: TSchema;
  schemaName: string;
  validateOutput?: (output: { validatedOutput: z.infer<TSchema>; rawOutput: string }) => void;
  /** Omit sensitive repair prompts and provider payloads from request logs. */
  redactRequestLog?: boolean;
  maxTokens?: number;
  metadata?: LLMRequestLogMetadata;
  signal?: AbortSignal;
};

export type GenerateTextInput = {
  system: string;
  user: string;
  images?: readonly LLMImageInput[];
  maxTokens?: number;
  metadata?: LLMRequestLogMetadata;
  signal?: AbortSignal;
};

export type LLMToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type GenerateToolCallInput = {
  system: string;
  user: string;
  tools: readonly LLMToolDefinition[];
  operationName: string;
  maxTokens?: number;
  metadata?: LLMRequestLogMetadata;
  signal?: AbortSignal;
};

export type LLMToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type LLMToolCallResult = {
  provider: LLMProviderName;
  model: string;
  rawOutput: string;
  toolCall: LLMToolCall;
  tokenUsage?: TokenUsage;
  warnings?: string[];
};

export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
};

export type LLMResult<T = unknown> = {
  provider: LLMProviderName;
  model: string;
  rawOutput: string;
  validatedOutput: T;
  tokenUsage?: TokenUsage;
  costEstimate?: number;
  warnings?: string[];
};

export type LLMTextResult = {
  provider: LLMProviderName;
  model: string;
  rawOutput: string;
  text: string;
  tokenUsage?: TokenUsage;
  costEstimate?: number;
  warnings?: string[];
};

export interface LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  readonly maxInputTokens?: number;
  readonly inputTokenLimitSource?: "user_override" | "model_capability" | "unknown_fallback";
  testConnection(): Promise<boolean>;
  getTokenUsage(): TokenUsage | undefined;
  generateText(input: GenerateTextInput): Promise<LLMTextResult>;
  generateStructuredOutput<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
  ): Promise<LLMResult<z.infer<TSchema>>>;
  generateToolCall(input: GenerateToolCallInput): Promise<LLMToolCallResult>;
}
