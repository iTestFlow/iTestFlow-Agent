import { describe, expect, it } from "vitest";
import { AppErrorCode } from "@/modules/shared/errors/app-error";
import { mapFriendlyError } from "./ai-generation-errors";

describe("mapFriendlyError", () => {
  it("maps structured error codes to friendly messages", () => {
    expect(mapFriendlyError({ code: AppErrorCode.TokenLimit })).toContain("Maximum output token cap");
    expect(mapFriendlyError({ code: AppErrorCode.InvalidJson })).toContain("not valid JSON");
    expect(mapFriendlyError({ code: AppErrorCode.SchemaValidation })).toContain("expected format");
    expect(mapFriendlyError({ code: AppErrorCode.ProviderUnavailable })).toContain("AI provider");
    expect(mapFriendlyError({ code: AppErrorCode.NoProvider })).toContain("No LLM provider");
    expect(mapFriendlyError({ code: AppErrorCode.Network })).toContain("Network error");
  });

  it("does not echo raw technical text for unmapped failures", () => {
    const raw = "LLM output for ExistingTestCaseReviewOutput exploded at line 914 column 48.";

    const friendly = mapFriendlyError({ raw });

    expect(friendly).toBe("The AI response could not be completed. You can retry or adjust the input.");
    expect(friendly).not.toBe(raw);
    expect(friendly).not.toContain("ExistingTestCaseReviewOutput");
  });
});
