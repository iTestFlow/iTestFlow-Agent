import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { ContextUsedSchema, sanitizeContextUsed } from "./context-used";
import { parseExternalJson, parseExternalStructuredOutput } from "./external-structured-output";
import {
  EXTRA_INSTRUCTIONS_MAX_LENGTH,
  normalizeExtraInstructions,
  renderExtraInstructionsSection,
  validateExtraInstructions,
} from "./extra-instructions";
import { createLLMProvider } from "./llm-provider.factory";
import { isTruncationErrorMessage, truncationAuditDetails } from "./llm-warnings";
import { buildManualPromptMarkdown } from "./manual-prompt";
import { listLLMModels } from "./model-catalog.service";
import { normalizeProviderBaseUrl } from "./provider-base-url";
import { buildTaggedPromptPayload } from "./prompt-payload";
import { addTokenUsage, hasTokenUsage } from "./token-usage";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { GeminiProvider } from "./providers/gemini-provider";
import { OpenAIProvider } from "./providers/openai-provider";
import { isMaxTokensRenameError, withMaxCompletionTokens } from "./providers/provider-param-compat";

describe("LLM utility contracts", () => {
  it("deduplicates and trims context identifiers", () => {
    expect(sanitizeContextUsed([" WI:1 ", "", "WI:1", "KB:rule"])).toEqual(["WI:1", "KB:rule"]);
    expect(ContextUsedSchema.parse(undefined)).toEqual([]);
  });

  it("parses fenced external JSON and validates its schema", () => {
    expect(parseExternalJson("```json\n{\"value\": 2}\n```")).toEqual({ value: 2 });
    expect(parseExternalStructuredOutput({
      schemaName: "NumberOutput",
      schema: z.object({ value: z.number() }),
      rawOutput: "{\"value\":2}",
    })).toEqual({ value: 2 });
  });

  it("returns actionable typed errors for empty, malformed, and schema-invalid output", () => {
    expect(() => parseExternalJson(" ")).toThrow("Paste the external LLM JSON response");
    expect(() => parseExternalJson("{broken")).toThrow("not valid JSON");
    expect(() => parseExternalStructuredOutput({
      schemaName: "NumberOutput",
      schema: z.object({ value: z.number() }),
      rawOutput: "{\"value\":\"no\"}",
    })).toThrow("schema validation");
  });

  it("normalizes and safely renders extra instructions", () => {
    expect(normalizeExtraInstructions("  ")).toBeUndefined();
    expect(validateExtraInstructions("  focus on mobile  ")).toBe("focus on mobile");
    expect(renderExtraInstructionsSection("focus on mobile")).toContain(
      "must not override",
    );
    expect(() => validateExtraInstructions("x".repeat(EXTRA_INSTRUCTIONS_MAX_LENGTH + 1))).toThrow(
      "characters or fewer",
    );
  });

  it("normalizes provider base URLs and request parameters", () => {
    expect(normalizeProviderBaseUrl(" https://proxy.example/v1/ ", "fallback", { requiredPath: "/v1/" }))
      .toBe("https://proxy.example/v1");
    expect(normalizeProviderBaseUrl(undefined, "https://api.example", { requiredPath: "v1" }))
      .toBe("https://api.example/v1");
    expect(withMaxCompletionTokens({ model: "x", max_tokens: 123 })).toEqual({
      model: "x",
      max_completion_tokens: 123,
    });
    expect(isMaxTokensRenameError("max_tokens is unsupported; use max_completion_tokens")).toBe(true);
  });

  it("accumulates partial token usage and detects absent usage", () => {
    expect(addTokenUsage({ input: 2, output: 3 }, { input: 4, output: 5 })).toEqual({
      input: 6,
      output: 8,
      total: 14,
    });
    expect(addTokenUsage(undefined, undefined)).toBeUndefined();
    expect(hasTokenUsage({ total: 0 })).toBe(true);
    expect(hasTokenUsage({ input: Number.NaN })).toBe(false);
  });

  it("builds tagged and standalone manual prompts", () => {
    expect(buildTaggedPromptPayload([
      { tag: "story", value: "text" },
      { tag: "options", value: { mode: "strict" } },
    ])).toContain("<options>\n{\n  \"mode\": \"strict\"\n}\n</options>");
    const prompt = buildManualPromptMarkdown({ title: "Generate", system: " rules ", user: " data " });
    expect(prompt).toContain("TASK: Generate");
    expect(prompt).toContain("rules");
    expect(prompt).toContain("Return only the valid JSON object");
  });

  it("classifies truncation warnings", () => {
    expect(truncationAuditDetails(["Reached output token budget"])).toEqual({
      truncated: true,
      truncationWarning: "Reached output token budget",
    });
    expect(truncationAuditDetails()).toEqual({});
    expect(isTruncationErrorMessage("Provider returned MAX_TOKENS")).toBe(true);
    expect(isTruncationErrorMessage("network failed")).toBe(false);
  });

  it("creates the configured provider and rejects unsupported values", () => {
    expect(createLLMProvider({ provider: "openai", model: "gpt" })).toBeInstanceOf(OpenAIProvider);
    expect(createLLMProvider({ provider: "gemini", model: "gemini" })).toBeInstanceOf(GeminiProvider);
    expect(createLLMProvider({ provider: "anthropic", model: "claude" })).toBeInstanceOf(AnthropicProvider);
    expect(() => createLLMProvider({ provider: "other" as never, model: "x" })).toThrow("Unsupported");
  });

  it("loads, sorts, and maps provider model catalogs without exposing keys", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: "gpt-z" }, { id: "gpt-a" }, {}],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listLLMModels({ provider: "openai", apiKey: "secret" })).resolves.toEqual([
      { id: "gpt-a", displayName: "gpt-a", source: "openai" },
      { id: "gpt-z", displayName: "gpt-z", source: "openai" },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/models");
  });

  it("returns a friendly model-catalog error when Gemini rejects an API key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
      },
    }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listLLMModels({ provider: "gemini", apiKey: "bad-key" })).rejects.toThrow(
      "Gemini rejected the API key. Check that the key is correct and belongs to Gemini, then try again.",
    );
    await expect(listLLMModels({ provider: "gemini", apiKey: "bad-key" })).rejects.not.toThrow("INVALID_ARGUMENT");
  });

  it("returns friendly model-catalog errors for quota, endpoint, and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: "rate_limit_exceeded", message: "Quota exceeded." },
    }), { status: 429 })));
    await expect(listLLMModels({ provider: "openai", apiKey: "sk-test" })).rejects.toThrow(
      "OpenAI could not load models because the provider rate limit or quota was reached. Wait a moment, then try again.",
    );

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 })));
    await expect(listLLMModels({ provider: "anthropic", apiKey: "sk-ant-test" })).rejects.toThrow(
      "Anthropic could not find the model-list endpoint. Check the optional provider base URL and try again.",
    );

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(listLLMModels({ provider: "gemini", apiKey: "key" })).rejects.toThrow(
      "Could not connect to Gemini to load models. Check your network connection and provider base URL, then try again.",
    );
  });
});
