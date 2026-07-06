import { describe, expect, it } from "vitest";

import { humanizeModelId, isProvider, modelDisplayLabel, providerLabel, type Provider } from "./topbar-labels";

describe("humanizeModelId", () => {
  it("strips the vendor prefix only when it matches the given provider", () => {
    expect(humanizeModelId("claude-sonnet-4", "anthropic")).toBe("Sonnet 4");
    expect(humanizeModelId("gemini-2.5-flash", "gemini")).toBe("2.5 Flash");
    expect(humanizeModelId("openai-gpt-4o", "openai")).toBe("GPT 4o");
    // A mismatched provider must not strip another vendor's prefix.
    expect(humanizeModelId("claude-sonnet-4", "gemini")).toBe("Claude Sonnet 4");
    // Unknown provider or none at all: stripping is a no-op.
    expect(humanizeModelId("gemini-2.5-flash", "mistral")).toBe("Gemini 2.5 Flash");
    expect(humanizeModelId("gemini-2.5-flash", null)).toBe("Gemini 2.5 Flash");
    expect(humanizeModelId("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
  });

  it("uses only the last path segment of namespaced ids", () => {
    expect(humanizeModelId("models/gemini-2.5-pro", "gemini")).toBe("2.5 Pro");
  });

  it('drops 8-digit date segments and "latest" markers', () => {
    expect(humanizeModelId("claude-3-5-sonnet-20241022", "anthropic")).toBe("3 5 Sonnet");
    expect(humanizeModelId("gemini-1.5-pro-latest", "gemini")).toBe("1.5 Pro");
    // "latest" is dropped regardless of case; 4-digit years are NOT dates.
    expect(humanizeModelId("gemini-1.5-pro-LATEST", "gemini")).toBe("1.5 Pro");
    expect(humanizeModelId("exp-2025", null)).toBe("Exp 2025");
  });

  it("caps the label at four parts, applied after filtering", () => {
    expect(humanizeModelId("alpha-beta-gamma-delta-epsilon", null)).toBe("Alpha Beta Gamma Delta");
    // A dropped date segment frees a slot for a later part.
    expect(humanizeModelId("claude-3-5-sonnet-20241022-v2-preview", "anthropic")).toBe("3 5 Sonnet v2");
  });

  it("uppercases gpt, keeps letter+digit and numeric parts verbatim, capitalizes the rest", () => {
    expect(humanizeModelId("gpt-4.1", "openai")).toBe("GPT 4.1");
    expect(humanizeModelId("o3-mini", "openai")).toBe("o3 Mini");
    expect(humanizeModelId("K2-instruct", null)).toBe("K2 Instruct");
    // Underscores separate parts just like hyphens.
    expect(humanizeModelId("flash_lite", null)).toBe("Flash Lite");
  });

  it('falls back to "Model" when nothing survives filtering', () => {
    expect(humanizeModelId("", "openai")).toBe("Model");
    expect(humanizeModelId("latest", null)).toBe("Model");
    expect(humanizeModelId("claude-latest", "anthropic")).toBe("Model");
  });
});

describe("providerLabel", () => {
  it("maps known providers to display names", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("gemini")).toBe("Gemini");
    expect(providerLabel("anthropic")).toBe("Anthropic");
  });

  it('passes unknown values through and falls back to "LLM" for empty ones', () => {
    expect(providerLabel("mistral")).toBe("mistral");
    expect(providerLabel("")).toBe("LLM");
    expect(providerLabel(null)).toBe("LLM");
    expect(providerLabel(undefined)).toBe("LLM");
  });
});

describe("modelDisplayLabel", () => {
  it("collapses Gemini models to their tier, most specific keyword first", () => {
    expect(modelDisplayLabel("gemini", "gemini-2.5-flash-lite")).toBe("Gemini: Flash Lite");
    expect(modelDisplayLabel("gemini", "gemini-2.5-flash")).toBe("Gemini: Flash");
    expect(modelDisplayLabel("gemini", "gemini-2.5-pro")).toBe("Gemini: Pro");
    // No tier keyword: falls back to the humanized id.
    expect(modelDisplayLabel("gemini", "gemini-exp-1206")).toBe("Gemini: Exp 1206");
    expect(modelDisplayLabel("gemini", null)).toBe("Gemini");
  });

  it("collapses Anthropic models to their family name", () => {
    expect(modelDisplayLabel("anthropic", "claude-3-5-haiku-20241022")).toBe("Claude: Haiku");
    expect(modelDisplayLabel("anthropic", "claude-sonnet-4-20250514")).toBe("Claude: Sonnet");
    expect(modelDisplayLabel("anthropic", "claude-opus-4")).toBe("Claude: Opus");
    // No family keyword: falls back to the humanized id.
    expect(modelDisplayLabel("anthropic", "claude-9")).toBe("Claude: 9");
    expect(modelDisplayLabel("anthropic", undefined)).toBe("Claude");
  });

  it("shortens OpenAI ids to the concise gpt-*/o* stem before humanizing", () => {
    // The stem stops at the first hyphen after the version: "-mini" is dropped.
    expect(modelDisplayLabel("openai", "gpt-4o-mini")).toBe("OpenAI: GPT 4o");
    expect(modelDisplayLabel("openai", "o3-mini")).toBe("OpenAI: o3 Mini");
    // Ids without a concise stem are humanized whole.
    expect(modelDisplayLabel("openai", "chatgpt-4o-latest")).toBe("OpenAI: Chatgpt 4o");
    expect(modelDisplayLabel("openai", null)).toBe("OpenAI");
  });

  it("falls back to the generic provider label for unknown or missing providers", () => {
    // Unknown provider passes through uncapitalized; its prefix is not stripped.
    expect(modelDisplayLabel("mistral", "mistral-large-2")).toBe("mistral: Mistral Large 2");
    expect(modelDisplayLabel(null, "some-model")).toBe("LLM: Some Model");
    expect(modelDisplayLabel(null, null)).toBe("LLM");
    expect(modelDisplayLabel(undefined, "")).toBe("LLM");
  });
});

describe("isProvider", () => {
  it("accepts exactly the three supported providers (case-sensitive)", () => {
    expect(isProvider("openai")).toBe(true);
    expect(isProvider("gemini")).toBe(true);
    expect(isProvider("anthropic")).toBe(true);
    expect(isProvider("OpenAI")).toBe(false);
    expect(isProvider("azure")).toBe(false);
    expect(isProvider("")).toBe(false);
    expect(isProvider(null)).toBe(false);
    expect(isProvider(undefined)).toBe(false);
  });

  it("narrows string | null to Provider", () => {
    const raw = "anthropic" as string | null;
    let narrowed: Provider | null = null;
    // The assignment below only type-checks because isProvider narrows raw.
    if (isProvider(raw)) narrowed = raw;
    expect(narrowed).toBe("anthropic");
  });
});
