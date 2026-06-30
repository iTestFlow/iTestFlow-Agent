import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm-request-log.service", () => ({
  writeLLMRequestLog: vi.fn(),
}));

import { AppErrorCode } from "@/modules/shared/errors/app-error";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import type { GenerateStructuredOutputInput } from "../llm-types";

class TestProvider extends BaseJsonProvider {
  structured: LLMProviderCallResult = { rawOutput: "{\"value\":1}" };
  text: LLMProviderCallResult = { rawOutput: " answer " };
  receivedMaxTokens?: number;
  structuredThrows?: unknown;
  textThrows?: unknown;
  beforeReturn?: () => void;

  async testConnection() {
    return true;
  }

  protected async callTextModel() {
    this.beforeReturn?.();
    if (this.textThrows) throw this.textThrows;
    return this.text;
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
  ) {
    this.receivedMaxTokens = input.maxTokens;
    if (this.structuredThrows) throw this.structuredThrows;
    return this.structured;
  }
}

function provider() {
  return new TestProvider({
    provider: "openai",
    model: "test",
    maxOutputTokenCap: 16000,
  });
}

describe("BaseJsonProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses and validates structured output within the configured cap", async () => {
    const instance = provider();
    const result = await instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "system",
      user: "user",
      maxTokens: 99999,
    });
    expect(result.validatedOutput).toEqual({ value: 1 });
    expect(instance.receivedMaxTokens).toBe(16000);
  });

  it("trims text, reports usage, and accumulates complete usage", async () => {
    const instance = provider();
    instance.text = {
      rawOutput: " answer ",
      tokenUsage: { input: 2, output: 3, total: 5 },
    };
    await expect(instance.generateText({ system: "s", user: "u" })).resolves.toMatchObject({
      text: "answer",
      tokenUsage: { input: 2, output: 3, total: 5 },
    });
    expect(instance.getTokenUsage()).toEqual({ input: 2, output: 3, total: 5 });
  });

  it("maps malformed and schema-invalid output to stable application errors", async () => {
    const instance = provider();
    instance.structured = { rawOutput: "{", finishReason: "max_tokens" };
    await expect(instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    })).rejects.toMatchObject({ code: AppErrorCode.TokenLimit });

    instance.structured = { rawOutput: "{\"value\":\"bad\"}" };
    await expect(instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    })).rejects.toMatchObject({ code: AppErrorCode.SchemaValidation });
  });

  it("surfaces provider failures without attempting schema validation", async () => {
    const instance = provider();
    instance.structured = {
      rawOutput: "{}",
      errorMessage: "upstream unavailable",
    };
    await expect(instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    })).rejects.toThrow("upstream unavailable");
  });

  it("maps a network-signature provider errorMessage to AppErrorCode.Network", async () => {
    const instance = provider();
    instance.structured = {
      rawOutput: "{}",
      errorMessage: "fetch failed",
    };
    await expect(instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    })).rejects.toMatchObject({
      code: AppErrorCode.Network,
      userMessage: "Network error. Check your connection and try again.",
    });
  });

  it("normalizes a raw thrown Error with a cause into a provider error", async () => {
    const instance = provider();
    const cause = new Error("connection reset by peer");
    (cause as Error & { code?: string }).code = "ECONNRESET";
    instance.structuredThrows = Object.assign(new Error("socket hang up"), { cause });
    await expect(instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    })).rejects.toMatchObject({
      // "socket" + the appended cause both match the network signature.
      code: AppErrorCode.Network,
      // describeCause renders message; name; code, and renderMessageWithCause appends it.
      message: "socket hang up; cause: connection reset by peer; code=ECONNRESET",
    });
  });

  it("normalizes a raw thrown Error from the text path via describeThrownError", async () => {
    const instance = provider();
    instance.textThrows = new Error("upstream blew up");
    await expect(instance.generateText({ system: "s", user: "u" }))
      .rejects.toMatchObject({
        code: AppErrorCode.ProviderUnavailable,
        message: "upstream blew up",
      });
  });

  it("returns validated output with a truncation warning when finishReason is length", async () => {
    const instance = provider();
    instance.structured = { rawOutput: "{\"value\":1}", finishReason: "length" };
    const result = await instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    });
    expect(result.validatedOutput).toEqual({ value: 1 });
    expect(result.warnings).toEqual([
      expect.stringContaining("Output was truncated at the 16,000-token output limit"),
    ]);
  });

  it("strips null and recurses into arrays before schema validation", async () => {
    const instance = provider();
    instance.structured = {
      rawOutput: JSON.stringify({
        value: 1,
        optional: null,
        items: [{ keep: 2, drop: null }, 3],
      }),
    };
    const result = await instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({
        value: z.number(),
        optional: z.string().optional(),
        items: z.array(z.union([z.object({ keep: z.number() }), z.number()])),
      }),
      system: "s",
      user: "u",
    });
    // null property dropped (optional becomes absent), array recursed, nested null dropped.
    expect(result.validatedOutput).toEqual({
      value: 1,
      items: [{ keep: 2 }, 3],
    });
  });

  it("falls back to the env/default cap when maxOutputTokenCap is not a positive integer", async () => {
    const instance = new TestProvider({
      provider: "openai",
      model: "test",
      maxOutputTokenCap: 0,
    });
    await instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    });
    // cap = positiveIntegerOrDefault(0, ...) falls back to DEFAULT_MAX_OUTPUT_TOKEN_CAP (32000);
    // no input.maxTokens => budget = min(default cap, cap) = 32000.
    expect(instance.receivedMaxTokens).toBe(32000);
  });

  it("formats a dropped-connection network message after a long duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const instance = provider();
    // Advance the frozen clock by 6 minutes during the call so durationMs >= 5 minutes,
    // exercising networkUserMessage's long-duration branch and formatDurationMs (m + s).
    instance.beforeReturn = () => {
      vi.setSystemTime(new Date("2026-01-01T00:06:30.000Z"));
    };
    instance.text = { rawOutput: "ignored", errorMessage: "socket hang up" };
    await expect(instance.generateText({ system: "s", user: "u" })).rejects.toMatchObject({
      code: AppErrorCode.Network,
      userMessage: expect.stringContaining("connection was dropped after 6m 30s"),
    });
  });

  it("describes a plain-object cause (non-Error) in the normalized message", async () => {
    const instance = provider();
    instance.structuredThrows = Object.assign(new Error("request failed"), {
      cause: { message: "name not resolved", name: "DNSError", code: "ENOTFOUND" },
    });
    await expect(instance.generateStructuredOutput({
      schemaName: "Value",
      schema: z.object({ value: z.number() }),
      system: "s",
      user: "u",
    })).rejects.toMatchObject({
      // ENOTFOUND matches the network signature; describeCause renders the object branch.
      code: AppErrorCode.Network,
      message: "request failed; cause: name not resolved; name=DNSError; code=ENOTFOUND",
    });
  });
});
