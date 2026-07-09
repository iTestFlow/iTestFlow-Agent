import { describe, expect, it } from "vitest";

import { formatAzureDevOpsError } from "@/shared/lib/sanitize-azure-error";
import {
  azureDevOpsIntegrationError,
  azureDevOpsInvalidResponseError,
  azureDevOpsTransportError,
  integrationCodeForStatus,
} from "./azure-devops-error";

describe("azureDevOpsIntegrationError", () => {
  it.each([
    [401, { message: "TF400813: not authorized" }, "integration_auth_failed"],
    [403, { message: "Access denied" }, "integration_permission_denied"],
    [
      403,
      {
        message: "TF400409: You do not have licensing rights to access this feature: Web-based Test Execution",
        typeName: "Microsoft.TeamFoundation.Server.Core.MissingLicenseException",
      },
      "integration_permission_denied",
    ],
    [404, { message: "TF401232: Work item 123 does not exist, or you do not have permissions to read it." }, "integration_not_found"],
    [429, { message: "Rate limit reached" }, "integration_rate_limited"],
    [500, { message: "Server failed" }, "integration_unavailable"],
    [400, { message: "Invalid request" }, "integration_validation"],
  ] as const)("keeps formatted Azure messages byte-identical for status %s", (status, body, code) => {
    const rawBody = JSON.stringify(body);
    const path = "_apis/testplan/plans?api-version=7.1";
    const error = azureDevOpsIntegrationError(status, rawBody, path);

    expect(error.message).toBe(formatAzureDevOpsError(status, rawBody, path));
    expect(error.providerId).toBe("azure-devops");
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(code);
  });

  it("keeps non-JSON Azure bodies on the same formatting path", () => {
    const body = "plain text failure";
    const error = azureDevOpsIntegrationError(502, body, "_apis/projects");

    expect(error.message).toBe(formatAzureDevOpsError(502, body, "_apis/projects"));
    expect(error.code).toBe("integration_unavailable");
  });
});

describe("integrationCodeForStatus", () => {
  it.each([
    [401, "integration_auth_failed"],
    [403, "integration_permission_denied"],
    [404, "integration_not_found"],
    [429, "integration_rate_limited"],
    [408, "integration_unavailable"],
    [503, "integration_unavailable"],
    [409, "integration_validation"],
    [418, "integration_unknown"],
  ] as const)("maps %s to %s", (status, code) => {
    expect(integrationCodeForStatus(status)).toBe(code);
  });
});

describe("azureDevOpsInvalidResponseError", () => {
  it("wraps client response-shape failures without changing the message", () => {
    const message =
      "Azure DevOps returned malformed JSON (200). Check that the organization URL and Personal Access Token are valid.";
    const error = azureDevOpsInvalidResponseError(message, 200);

    expect(error.message).toBe(message);
    expect(error.code).toBe("integration_invalid_response");
    expect(error.providerId).toBe("azure-devops");
    expect(error.statusCode).toBe(200);
  });
});

describe("azureDevOpsTransportError", () => {
  it("preserves Error messages and cause", () => {
    const cause = new Error("ECONNRESET");
    const error = azureDevOpsTransportError(cause);

    expect(error.message).toBe("ECONNRESET");
    expect(error.code).toBe("integration_unavailable");
    expect(error.providerId).toBe("azure-devops");
    expect(error.statusCode).toBeUndefined();
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("preserves string rejection messages", () => {
    const error = azureDevOpsTransportError("socket hang up");

    expect(error.message).toBe("socket hang up");
    expect(error.code).toBe("integration_unavailable");
    expect((error as Error & { cause?: unknown }).cause).toBe("socket hang up");
  });

  it("uses the fallback message for exotic rejection values", () => {
    const cause = { reason: "unknown" };
    const error = azureDevOpsTransportError(cause, "Azure DevOps request failed.");

    expect(error.message).toBe("Azure DevOps request failed.");
    expect(error.code).toBe("integration_unavailable");
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});
