import { z } from "zod";

export type LLMProviderName = "openai" | "gemini" | "anthropic" | "ollama";

export type LLMProviderConfig = {
  provider: LLMProviderName;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
};

export type GenerateStructuredOutputInput<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  system: string;
  user: string;
  schema: TSchema;
  schemaName: string;
  temperature?: number;
  maxTokens?: number;
};

export type LLMResult<T = unknown> = {
  provider: LLMProviderName;
  model: string;
  rawOutput: string;
  validatedOutput: T;
  tokenUsage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  costEstimate?: number;
};

export interface LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  testConnection(): Promise<boolean>;
  generateStructuredOutput<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
  ): Promise<LLMResult<z.infer<TSchema>>>;
}
