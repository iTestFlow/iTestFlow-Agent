import { afterEach, describe, expect, it, vi } from "vitest";
import { azureDevOpsIntegrationError } from "@/modules/integrations/azure-devops/azure-devops-error";
import { AppError, AppErrorCode } from "./app-error";
import {
  statusForCode,
  statusForManualValidationError,
  statusForServerError,
  toFriendlyErrorResponse,
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
    const response = toErrorResponse(new Error("Plain failure."), {
      fallback: "The request could not be completed.",
    });

    expect(response).toEqual({
      error: "The request could not be completed.",
      technicalDetails: "HTTP status: 500\nRaw error: Plain failure.",
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

describe("toFriendlyErrorResponse", () => {
  it("maps raw Gemini JSON to a friendly error and technical details", () => {
    const raw = `Gemini model list request failed (400): {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}`;

    const response = toFriendlyErrorResponse(new Error(raw), {
      domain: "llm",
      provider: "gemini",
      status: 400,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Gemini rejected the API key. Check that the key is correct and belongs to Gemini, then try again.");
    expect(response.body.error).not.toContain("{");
    expect(response.body.technicalDetails).toContain("INVALID_ARGUMENT");
  });

  it("redacts secrets and caps raw technical details", () => {
    const secret = "pat: super-secret-token";
    const raw = `Azure DevOps rejected the Personal Access Token. ${secret} ${"x".repeat(1500)}`;

    const response = toFriendlyErrorResponse(new Error(raw), {
      domain: "azure",
      status: 401,
    });

    expect(response.body.error).toBe("Azure DevOps authentication failed. Check that your Personal Access Token is valid and has not expired, then try again.");
    expect(response.body.technicalDetails).not.toContain("super-secret-token");
    expect(response.body.technicalDetails).toContain("[redacted]");
    expect(response.body.technicalDetails?.length).toBeLessThanOrEqual(1235);
  });

  it("turns HTML gateway pages into a stable friendly message", () => {
    const response = toFriendlyErrorResponse(
      new Error("<!doctype html><html><body>502 Bad Gateway</body></html>"),
      { fallback: "Dashboard analytics failed." },
    );

    expect(response.body.error).toBe("The service is temporarily unavailable. Try again in a moment.");
    expect(response.body.technicalDetails).toContain("Bad Gateway");
  });

  it("keeps explicit 422 status for AppErrors", () => {
    const response = toFriendlyErrorResponse(
      new AppError({
        code: AppErrorCode.InvalidJson,
        message: "External LLM output was not valid JSON.",
        userMessage: "The external LLM response was not valid JSON.",
      }),
      { status: 422 },
    );

    expect(response.status).toBe(422);
    expect(response.body.error).toBe("The external LLM response was not valid JSON.");
  });

  it("preserves curated Azure guidance through explicit 503 routes", () => {
    const guidance = "Your Azure DevOps account isn't licensed to use Test Plans. Ask an Azure DevOps administrator to assign Basic + Test Plans or Visual Studio Enterprise access, then try again.";
    const response = toFriendlyErrorResponse(new Error(guidance), {
      domain: "azure",
      status: 503,
      fallback: "Azure Test Plan publish failed.",
    });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe(guidance);
  });

  it("preserves Azure Test Plans access guidance with straight or smart apostrophes", () => {
    const guidance = "You don\u2019t have access to Azure Test Plans. Ask an Azure DevOps administrator to update your license, then try again.";
    const response = toFriendlyErrorResponse(new Error(guidance), {
      domain: "azure",
      status: 503,
      fallback: "Azure Test Plan publish failed.",
    });

    expect(response.body.error).toBe(guidance);
  });

  it("preserves suite migration validation details through explicit 503 routes", () => {
    const response = toFriendlyErrorResponse(new Error("Selected suite 42 was not found in the source test plan."), {
      domain: "azure",
      status: 503,
      fallback: "Suite migration failed.",
    });

    expect(response.body.error).toBe("Selected suite 42 was not found in the source test plan.");
  });

  it("preserves Azure non-JSON org and PAT guidance", () => {
    const guidance = "Azure DevOps returned a non-JSON response (200). Check that the organization URL and Personal Access Token are valid.";
    const response = toFriendlyErrorResponse(new Error(guidance), {
      domain: "azure",
      status: 503,
      fallback: "Azure DevOps project fetch failed.",
    });

    expect(response.body.error).toBe(guidance);
  });

  it("preserves suite migration parent-suite guidance", () => {
    const parentMissing = "Parent suite 123 was not found in test plan 456.";
    const targetParentMissing = "Target parent suite 789 was not found in the target test plan.";
    const targetConflict = "Target parent suite cannot be one of the selected source suites or their descendants.";

    expect(toFriendlyErrorResponse(new Error(parentMissing), {
      domain: "azure",
      status: 503,
      fallback: "Azure Test Plan publish failed.",
    }).body.error).toBe(parentMissing);
    expect(toFriendlyErrorResponse(new Error(targetParentMissing), {
      domain: "azure",
      status: 503,
      fallback: "Suite migration failed.",
    }).body.error).toBe(targetParentMissing);
    expect(toFriendlyErrorResponse(new Error(targetConflict), {
      domain: "azure",
      status: 503,
      fallback: "Suite migration failed.",
    }).body.error).toBe(targetConflict);
  });

  it("maps Azure TF401232 to a work-item ID guidance message", () => {
    const response = toFriendlyErrorResponse(
      new Error("TF401232: Work item 123 does not exist, or you do not have permissions to read it."),
      { domain: "azure", status: 503, fallback: "Linked test case fetch failed." },
    );

    expect(response.body.error).toBe("The work item was not found in the selected Azure DevOps project, or your account cannot read it. Check the ID and selected project, then try again.");
  });

  it("does not classify project-level missing-or-permission errors as work-item failures", () => {
    const response = toFriendlyErrorResponse(
      new Error("VS800075: The project with id 'dead-project' does not exist, or you do not have permission to access it."),
      { domain: "azure", status: 503, fallback: "Azure DevOps project fetch failed." },
    );

    expect(response.body.error).toBe("Azure DevOps project fetch failed.");
  });

  it("preserves Azure login missing-identity guidance", () => {
    const response = toFriendlyErrorResponse(
      new Error("Azure DevOps did not return an identity for this token."),
      { domain: "azure", status: 401, fallback: "Azure DevOps authentication failed." },
    );

    expect(response.body.error).toBe("Azure DevOps did not return an identity for this token. Check that the PAT belongs to the selected organization and try again.");
  });

  it("only infers provider and network codes for explicit LLM-domain errors", () => {
    const azure = toFriendlyErrorResponse(new Error("Azure unavailable"), {
      domain: "azure",
      status: 503,
      fallback: "Azure DevOps project fetch failed.",
    });
    const llm = toFriendlyErrorResponse(new Error("OpenAI unavailable"), {
      domain: "llm",
      status: 503,
      fallback: "Generation failed.",
    });

    expect(azure.body.code).toBeUndefined();
    expect(llm.body.code).toBe(AppErrorCode.ProviderUnavailable);
  });

  it.each([
    [401, JSON.stringify({ message: "TF400813: not authorized" })],
    [403, JSON.stringify({ message: "TF400409: You do not have licensing rights to access this feature: Web-based Test Execution" })],
    [404, JSON.stringify({ message: "TF401232: Work item 123 does not exist, or you do not have permissions to read it." })],
    [429, JSON.stringify({ message: "Rate limit reached" })],
    [500, "plain text failure"],
  ] as const)("treats Azure IntegrationError like a plain Error for response text (%s)", (status, body) => {
    const integrationError = azureDevOpsIntegrationError(status, body, "_apis/testplan/plans?api-version=7.1");
    const plainError = new Error(integrationError.message);
    const options = {
      domain: "azure" as const,
      status: 503,
      fallback: "Azure DevOps project fetch failed.",
    };

    expect(toFriendlyErrorResponse(integrationError, options)).toEqual(
      toFriendlyErrorResponse(plainError, options),
    );
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

  it("does not infer auth status from plain error text", () => {
    const error = new Error("Azure DevOps authentication failed. Check that your Personal Access Token is valid and has not expired, then sign in again.");

    expect(statusForServerError(error)).toBe(500);
    expect(toFriendlyErrorResponse(error, { domain: "azure" }).status).toBe(500);
  });

  it("uses explicit status for plain errors without sniffing bare numbers", () => {
    expect(statusForServerError(new Error("Work item 401 failed"))).toBe(500);
    expect(toFriendlyErrorResponse(new Error("Work item 401 failed"), { status: 503 }).status).toBe(503);
  });
});
