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

export type GenerateStructuredOutputInput<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  system: string;
  user: string;
  schema: TSchema;
  schemaName: string;
  maxTokens?: number;
  metadata?: LLMRequestLogMetadata;
  signal?: AbortSignal;
};

export type GenerateTextInput = {
  system: string;
  user: string;
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
