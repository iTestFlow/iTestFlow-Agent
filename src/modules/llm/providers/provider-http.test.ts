import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../llm-request-log.service", () => ({
  writeLLMRequestLog: vi.fn(),
}));

import { AnthropicProvider } from "./anthropic-provider";
import { fetchWithTransientRetry } from "./fetch-with-transient-retry";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";
import { RequirementAnalysisOutputSchema } from "../../requirement-analysis/schemas/requirement-analysis.schema";
import { TestCaseGenerationOutputSchema } from "../../test-case-design/schemas/test-case.schema";
import { ExistingTestCaseReviewOutputSchema } from "../../existing-test-case-review/schemas/existing-test-case-review.schema";
import { ProjectKnowledgeGeneratedBaseSchema } from "../../rag/project-knowledge-grounding";

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

  it.each(["claude-sonnet-5", "claude-fable-5"])(
    "reads %s structured output from text blocks after adaptive thinking",
    async (model) => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        content: [
          { type: "thinking", thinking: "I will produce the requested object.", signature: "signature" },
          { type: "text", text: "{\"value\":1,\"checklistItemId\":\"ambiguity_clarity\",\"format\":\"json\"}" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
      }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const provider = new AnthropicProvider({
        provider: "anthropic",
        model,
        apiKey: "key",
        retryAttempts: 0,
      });

      await expect(provider.generateStructuredOutput({
        schemaName: "ExampleOutput",
        schema: z.object({
          value: z.number().min(0).max(100),
          checklistItemId: z.enum(["ambiguity_clarity", "impact_risk_assessment"]),
          format: z.string(),
        }),
        system: "Return structured data.",
        user: "Create the object.",
      })).resolves.toMatchObject({
        rawOutput: "{\"value\":1,\"checklistItemId\":\"ambiguity_clarity\",\"format\":\"json\"}",
        validatedOutput: { value: 1, checklistItemId: "ambiguity_clarity", format: "json" },
        tokenUsage: { input: 10, output: 20, total: 30 },
      });
      const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(requestBody.output_config).toEqual({
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              value: { type: "number" },
              checklistItemId: {
                type: "string",
                enum: ["ambiguity_clarity", "impact_risk_assessment"],
              },
              format: { type: "string" },
            },
            required: ["value", "checklistItemId", "format"],
            additionalProperties: false,
          },
        },
      });
    },
  );

  it.each([
    ["the compiled grammar is too large", "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."],
    ["there are too many optional parameters", "Schemas contains too many optional parameters (37), which would make grammar compilation inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24)."],
  ])("falls back to prompt-only JSON when Anthropic native schema reports %s", async (_reason, errorMessage) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: errorMessage,
        },
        type: "error",
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: [{ type: "text", text: "{\"value\":1}" }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "key",
      retryAttempts: 0,
    });

    await expect(provider.generateStructuredOutput({
      schemaName: "ExampleOutput",
      schema: z.object({ value: z.number() }),
      system: "Return structured data.",
      user: "Create the object.",
    })).resolves.toMatchObject({
      rawOutput: "{\"value\":1}",
      validatedOutput: { value: 1 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const nativeBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(nativeBody.output_config).toBeDefined();
    expect(fallbackBody).not.toHaveProperty("output_config");
  });

  it("reports a friendly Anthropic error when no final text block is returned", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      content: [
        { type: "thinking", thinking: "Reasoning only.", signature: "signature" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "key",
      retryAttempts: 0,
    });

    await expect(provider.generateStructuredOutput({
      schemaName: "ExampleOutput",
      schema: z.object({ value: z.number() }),
      system: "Return structured data.",
      user: "Create the object.",
    })).rejects.toMatchObject({
      userMessage: "Claude completed the request without a final JSON response. Please retry; if this repeats, choose another model.",
      message: expect.stringContaining("Content block types: thinking"),
    });
  });

  it("constrains Sonnet 5 requirement-analysis enum values with the native schema", async () => {
    const output = {
      findings: [],
      summary: {
        totalFindings: 0,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        infoCount: 0,
        overallQuality: "good",
        completenessScore: 90,
        clarityScore: 90,
        testabilityScore: 90,
        summaryText: "The requirement is clear.",
      },
      recommendations: [],
      questionsForProductOwner: [],
      contextUsed: [],
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(output) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "key",
      retryAttempts: 0,
    });

    await provider.generateStructuredOutput({
      schemaName: "RequirementAnalysisOutput",
      schema: RequirementAnalysisOutputSchema,
      system: "Analyze the requirement.",
      user: "Return the analysis.",
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const sentSchema = requestBody.output_config.format.schema;
    expect(sentSchema.properties.findings.items.properties.checklistItemId.enum).toContain("ambiguity_clarity");
    expect(sentSchema.properties.findings.items.properties.checklistItemId.enum).not.toContain("traceability_gap");
    expect(JSON.stringify(sentSchema)).not.toMatch(/"(?:minimum|maximum|minLength|maxLength|format)":/);
  });

  it("sends a concrete native schema for optional knowledge constraints", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "key",
      retryAttempts: 0,
    });

    await expect(provider.generateStructuredOutput({
      schemaName: "ProjectKnowledgeGeneratedBase",
      schema: ProjectKnowledgeGeneratedBaseSchema,
      system: "Build project knowledge.",
      user: "Extract supported knowledge.",
    })).resolves.toMatchObject({
      validatedOutput: {
        modules: [],
        businessRules: [],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      },
    });

    const sentSchema = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
      .output_config.format.schema;
    expect(sentSchema.properties.businessRules.items.properties.constraint).toEqual({
      type: "object",
      properties: {
        object: { type: "string" },
        property: { type: "string" },
        condition: { type: "string" },
        operator: { type: "string" },
        value: { type: "string" },
        valueType: { type: "string" },
        unit: { type: "string" },
      },
      additionalProperties: false,
    });
  });

  it("applies native schemas to Sonnet 5 test design and gap analysis", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "key",
      retryAttempts: 0,
    });

    for (const [schemaName, schema] of [
      ["TestCaseGenerationOutput", TestCaseGenerationOutputSchema],
      ["ExistingTestCaseReviewOutput", ExistingTestCaseReviewOutputSchema],
    ] as const) {
      await expect(provider.generateStructuredOutput({
        schemaName,
        schema,
        system: "Return structured data.",
        user: "Analyze the supplied requirement.",
      })).rejects.toMatchObject({ code: "schema_validation" });
    }

    const testDesignSchema = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
      .output_config.format.schema;
    expect(testDesignSchema.properties.testCases.items.properties.type.enum).toContain("functional");
    expect(testDesignSchema.properties.testCases.items.properties.priority.enum).toEqual([1, 2, 3, 4]);

    const gapAnalysisSchema = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
      .output_config.format.schema;
    expect(gapAnalysisSchema.properties.traceabilityMatrix.items.properties.coverageStatus.enum)
      .toContain("Not covered");
    expect(gapAnalysisSchema.properties.findings.items.properties.category.enum)
      .toContain("Missing coverage");
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

  it("keeps half the exponential backoff as the jitter floor", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // Equal jitter over the 750ms base: floor at 375ms, never zero-delay.
    vi.spyOn(Math, "random").mockReturnValue(0);

    const pending = fetchWithTransientRetry("https://example.test", {}, 1);
    await vi.advanceTimersByTimeAsync(374);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps the jittered backoff at the deterministic exponential delay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // Mocked upper bound of the jitter window: 375 + 1 * 375 = the deterministic
    // 750ms base. Real Math.random() stays strictly below it.
    vi.spyOn(Math, "random").mockReturnValue(1);

    const pending = fetchWithTransientRetry("https://example.test", {}, 1);
    await vi.advanceTimersByTimeAsync(749);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
