import { describe, expect, it } from "vitest";

import { isAppError } from "@/modules/shared/errors/app-error";
import {
  INTEGRATION_ERROR_CODES,
  IntegrationError,
  isIntegrationError,
  type IntegrationErrorCode,
} from "./integration-error";

describe("IntegrationError", () => {
  it("carries integration metadata without becoming an AppError", () => {
    for (const code of INTEGRATION_ERROR_CODES) {
      const error = new IntegrationError({
        providerId: "azure-devops",
        code,
        statusCode: 503,
        message: `Example ${code}`,
      });

      expect(error.message).toBe(`Example ${code}`);
      expect(error.code).toBe(code);
      expect(error.providerId).toBe("azure-devops");
      expect(error.statusCode).toBe(503);
      expect(isIntegrationError(error)).toBe(true);
      expect(isAppError(error)).toBe(false);
    }
  });

  it("recognizes IntegrationError-shaped values from module boundaries", () => {
    const value = {
      message: "Unsupported provider.",
      code: "integration_unsupported_provider" satisfies IntegrationErrorCode,
      providerId: "example",
    };

    expect(isIntegrationError(value)).toBe(true);
  });

  it("rejects AppError-shaped and unknown code values", () => {
    expect(isIntegrationError({ message: "Nope", userMessage: "Nope", code: "unknown" })).toBe(false);
    expect(isIntegrationError({ message: "Nope", code: "not_integration" })).toBe(false);
  });
});
