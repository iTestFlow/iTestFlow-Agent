import { describe, expect, it } from "vitest";

import { formatAzureDevOpsError, sanitizeAzureError } from "./sanitize-azure-error";

describe("sanitizeAzureError", () => {
  it("redacts credentials embedded in Azure error text", () => {
    expect(sanitizeAzureError(
      "Authorization: Basic QWxhZGRpbjpPcGVuU2VzYW1l personalAccessToken=secret-value",
    )).toBe("Authorization: Basic [redacted] personalAccessToken: [redacted]");
  });
});

describe("formatAzureDevOpsError", () => {
  it("turns the Azure Test Plans license exception into actionable guidance", () => {
    const body = JSON.stringify({
      $id: "1",
      message: "TF400409: You do not have licensing rights to access this feature: Web-based Test Execution",
      typeName: "Microsoft.TeamFoundation.Server.Core.MissingLicenseException",
      eventId: 3000,
    });

    const message = formatAzureDevOpsError(
      403,
      body,
      "project/_apis/testplan/plans?api-version=7.1",
    );

    expect(message).toBe(
      "Your Azure DevOps account isn’t licensed to use Test Plans. Ask an Azure DevOps administrator to assign Basic + Test Plans or Visual Studio Enterprise access, then try again.",
    );
    expect(message).not.toContain("TF400409");
    expect(message).not.toContain("MissingLicenseException");
  });

  it("explains a permission-denied response from any Test Plans API", () => {
    expect(formatAzureDevOpsError(
      403,
      JSON.stringify({ message: "Access denied" }),
      "project/_apis/test/Plans/12/Suites/34/points?api-version=7.1",
    )).toBe(
      "You don’t have access to Azure Test Plans for this project. Ask an Azure DevOps administrator to grant the required license and project permissions. If you use a PAT, make sure it includes the Test Management scope, then try again.",
    );
  });

  it("uses a friendly generic message for other forbidden Azure requests", () => {
    expect(formatAzureDevOpsError(
      403,
      JSON.stringify({ message: "The user is not authorized." }),
      "project/_apis/wit/workitems/123",
    )).toBe(
      "Azure DevOps denied this request. Ask an Azure DevOps administrator to check your project permissions and Personal Access Token scopes, then try again.",
    );
  });

  it("keeps a concise Azure message for unrelated failures instead of raw JSON", () => {
    expect(formatAzureDevOpsError(
      404,
      JSON.stringify({ message: "The requested test plan was not found.", typeName: "Azure.Exception" }),
    )).toBe("Azure DevOps request failed (404): The requested test plan was not found.");
  });
});
