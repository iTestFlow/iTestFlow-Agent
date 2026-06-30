import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm-request-log.service", () => ({
  writeLLMRequestLog: vi.fn(),
}));

import { AnthropicProvider } from "./anthropic-provider";
import { fetchWithTransientRetry } from "./fetch-with-transient-retry";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";

describe("provider HTTP adapters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps OpenAI text responses and usage", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIProvider({
      provider: "openai", model: "gpt-test", apiKey: "key", retryAttempts: 0,
    });
    await expect(provider.generateText({ system: "s", user: "u", maxTokens: 50 })).resolves.toMatchObject({
      text: "hello",
      tokenUsage: { input: 2, output: 3, total: 5 },
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-test", max_tokens: 50 });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
  });

  it("self-corrects OpenAI max_tokens once and remembers it", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        "max_tokens is unsupported; use max_completion_tokens",
        { status: 400 },
      ))
      .mockImplementation(async () => new Response(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIProvider({
      provider: "openai", model: "reasoning", apiKey: "key", retryAttempts: 0,
    });
    await provider.generateText({ system: "s", user: "u" });
    await provider.generateText({ system: "s", user: "u" });
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody).toHaveProperty("max_completion_tokens");
    expect(secondBody).not.toHaveProperty("max_tokens");
    const thirdBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(thirdBody).toHaveProperty("max_completion_tokens");
    expect(thirdBody).not.toHaveProperty("max_tokens");
  });

  it("maps Gemini responses and disables thinking for flash 2.5", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "gemini answer" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, totalTokenCount: 8 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GeminiProvider({
      provider: "gemini", model: "gemini-2.5-flash", apiKey: "key", retryAttempts: 0,
    });
    await expect(provider.generateText({ system: "s", user: "u" })).resolves.toMatchObject({
      text: "gemini answer",
      tokenUsage: { input: 3, output: 5, total: 8 },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).generationConfig)
      .toHaveProperty("thinkingConfig.thinkingBudget", 0);
  });

  it("normalizes Anthropic base URLs and cached-token usage", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      content: [{ text: "claude answer" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        output_tokens: 5,
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      provider: "anthropic",
      model: "claude",
      apiKey: "key",
      baseUrl: "https://proxy.example/",
      retryAttempts: 0,
    });
    await expect(provider.generateText({ system: "s", user: "u" })).resolves.toMatchObject({
      tokenUsage: { input: 9, output: 5, total: 14 },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/v1/messages");
  });

  it("retries transient responses and network failures with deterministic timers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new Error("reset"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchWithTransientRetry("https://example.test", {}, 2);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honors a numeric Retry-After header before retrying a 503", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchWithTransientRetry("https://example.test", {}, 1);
    // Numeric Retry-After of "2" => 2000ms. Just before the deadline the retry must not fire.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Crossing the 2000ms boundary releases the scheduled retry.
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors an HTTP-date Retry-After header under frozen time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    // 5 seconds in the future relative to the frozen clock => deterministic 5000ms delay.
    const retryAfter = new Date("2026-01-01T00:00:05.000Z").toUTCString();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": retryAfter } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchWithTransientRetry("https://example.test", {}, 1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the final transient response when status retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("still busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchWithTransientRetry("https://example.test", {}, 1);
    await vi.runAllTimersAsync();
    // retriesUsed (1) >= retryAttempts (1): the last transient Response is returned, not thrown.
    await expect(pending).resolves.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-throws the network error when retries are exhausted on a thrown error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchWithTransientRetry("https://example.test", {}, 1);
    const assertion = expect(pending).rejects.toThrow("ECONNRESET");
    await vi.runAllTimersAsync();
    await assertion;
    // First throw retries (delay), second throw exhausts retries and re-throws.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
