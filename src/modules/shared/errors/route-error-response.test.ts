import { describe, expect, it } from "vitest";
import { IntegrationError } from "@/modules/integrations/core/integration-error";
import { integrationScopeHeaders, routeErrorResponse } from "./route-error-response";

describe("integrationScopeHeaders", () => {
  it("marks integration errors with a discriminator header", () => {
    const error = new IntegrationError({
      providerId: "azure-devops",
      code: "integration_auth_failed",
      message: "Azure DevOps request failed.",
    });

    expect(integrationScopeHeaders(error)).toEqual({ "x-itf-error-scope": "integration" });
    expect(integrationScopeHeaders(new Error("Authentication required."))).toBeUndefined();
  });
});

describe("routeErrorResponse", () => {
  it("returns mapped integration status and header", async () => {
    const error = new IntegrationError({
      providerId: "azure-devops",
      code: "integration_auth_failed",
      message: "Azure DevOps request failed.",
    });

    const response = routeErrorResponse(error, {
      domain: "azure",
      status: 503,
      fallback: "Azure DevOps profile fetch failed.",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
    await expect(response.json()).resolves.toMatchObject({
      error: "Azure DevOps request failed.",
    });
  });

  it("leaves plain 401 auth responses unmarked", () => {
    const response = routeErrorResponse(new Error("Authentication required."), {
      domain: "auth",
      status: 401,
      fallback: "Sign in required.",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBeNull();
  });
});
