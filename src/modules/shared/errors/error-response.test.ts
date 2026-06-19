import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, AppErrorCode } from "./app-error";
import {
  statusForCode,
  statusForManualValidationError,
  statusForServerError,
  toErrorResponse,
} from "./error-response";

describe("toErrorResponse", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serializes AppError with distinct friendly and technical details", () => {
    const error = new AppError({
      code: AppErrorCode.TokenLimit,
      message: "LLM output for ExampleOutput was not valid JSON: output-token limit stopped the response.",
      userMessage: 'The AI response ran out of output space. Increase the "Maximum output token cap" in Settings.',
      technicalContext: {
        provider: "openai",
        model: "gpt-test",
        schemaName: "ExampleOutput",
        finishReason: "length",
        tokenUsage: { input: 10, output: 20, total: 30 },
        parsePosition: 1200,
        jsonSnippet: "x".repeat(500),
        rawOutputExcerpt: "y".repeat(1000),
      },
    });

    const response = toErrorResponse(error);

    expect(response.error).toBe(error.userMessage);
    expect(response.technicalDetails).toBeTruthy();
    expect(response.technicalDetails).not.toBe(response.error);
    expect(response.technicalDetails).toContain("Provider: openai");
    expect(response.technicalContext?.jsonSnippet?.length).toBeLessThanOrEqual(303);
    expect(response.technicalContext?.rawOutputExcerpt?.length).toBeLessThanOrEqual(803);
  });

  it("degrades plain errors to unknown", () => {
    const response = toErrorResponse(new Error("Plain failure."));

    expect(response).toEqual({
      error: "Plain failure.",
      code: AppErrorCode.Unknown,
      technicalDetails: "Plain failure.",
    });
  });

  it("strips raw output excerpts in production responses", () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = new AppError({
      code: AppErrorCode.InvalidJson,
      message: "LLM output was not valid JSON.",
      userMessage: "The AI response was not valid JSON.",
      technicalContext: {
        schemaName: "ExampleOutput",
        rawOutputExcerpt: "sensitive raw output",
      },
    });

    const response = toErrorResponse(error);

    expect(response.technicalContext?.rawOutputExcerpt).toBeUndefined();
    expect(response.technicalDetails).not.toContain("sensitive raw output");
  });
});

describe("error statuses", () => {
  it("maps server codes to response statuses", () => {
    expect(statusForCode(AppErrorCode.Network)).toBe(502);
    expect(statusForCode(AppErrorCode.ProviderUnavailable)).toBe(503);
    expect(statusForCode(AppErrorCode.TokenLimit)).toBe(503);
    expect(statusForCode(AppErrorCode.InvalidJson)).toBe(503);
    expect(statusForCode(AppErrorCode.SchemaValidation)).toBe(503);
    expect(statusForCode(AppErrorCode.Unknown)).toBe(500);
  });

  it("uses 422 for manual parse and schema validation errors", () => {
    const error = new AppError({
      code: AppErrorCode.SchemaValidation,
      message: "External LLM output failed schema validation.",
      userMessage: "The external LLM response did not match the expected format.",
    });

    expect(statusForManualValidationError(error)).toBe(422);
    expect(statusForServerError(error)).toBe(503);
  });
});
