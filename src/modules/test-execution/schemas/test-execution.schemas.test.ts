import { describe, expect, it } from "vitest";

import {
  EnvironmentConfigInputSchema,
  EnvironmentCreateSchema,
  RunEnvironmentSelectionSchema,
  SecretInputSchema,
  WorkspaceEgressRuleInputSchema,
} from "./test-execution.schemas";

describe("test execution environment schemas", () => {
  it("keeps legacy browser-only inputs compatible and defaults new targets", () => {
    const parsed = EnvironmentConfigInputSchema.parse({
      name: "QA",
      initialUrl: "https://app.example.com/login",
      allowedOrigin: "https://app.example.com",
    });

    expect(parsed.api).toBeNull();
    expect(parsed.database).toBeNull();
    expect(parsed.viewportWidth).toBe(1280);
  });

  it("accepts an API-only one-time environment", () => {
    const parsed = RunEnvironmentSelectionSchema.parse({
      mode: "one_time",
      config: {
        api: {
          baseUrl: "https://api.example.com/v1",
          auth: { type: "bearer" },
        },
      },
      secrets: [
        {
          secretName: "api.bearer_token",
          title: "API token",
          value: "hidden",
          purpose: "api_auth",
        },
      ],
    });

    expect(parsed.mode).toBe("one_time");
    if (parsed.mode !== "one_time") throw new Error("Expected one-time environment.");
    expect(parsed.config.initialUrl).toBe("");
    expect(parsed.config.api?.requestTimeoutMs).toBe(30_000);
  });

  it("accepts a database-only environment for each supported driver", () => {
    for (const [driver, port, schema] of [
      ["postgres", 5432, "public"],
      ["sqlserver", 1433, "dbo"],
      ["mysql", 3306, "app"],
    ] as const) {
      const parsed = EnvironmentConfigInputSchema.safeParse({
        name: `${driver} QA`,
        database: {
          driver,
          host: "db.internal.example",
          port,
          databaseName: "qa",
          username: "itestflow",
          schemas: [schema],
        },
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("requires a target and treats browser URL/origin as one pair", () => {
    expect(EnvironmentConfigInputSchema.safeParse({ name: "Empty" }).success).toBe(false);
    expect(
      EnvironmentConfigInputSchema.safeParse({
        name: "Half browser",
        initialUrl: "https://app.example.com",
      }).success,
    ).toBe(false);
  });

  it("does not accept a browser login plan for an API-only environment", () => {
    const result = EnvironmentConfigInputSchema.safeParse({
      name: "API only",
      api: { baseUrl: "https://api.example.com" },
      loginPlan: {
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Sign in", expectedResult: "Dashboard opens" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("limits URL-based OpenAPI discovery to the API origin", () => {
    const result = EnvironmentConfigInputSchema.safeParse({
      name: "API",
      api: {
        baseUrl: "https://api.example.com/v1",
        contract: { kind: "same_origin_url", url: "https://evil.example/openapi.json" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("purpose-scopes connection secret names", () => {
    expect(
      SecretInputSchema.safeParse({
        secretName: "DEFAULT_PASSWORD",
        title: "Password",
        value: "secret",
      }).success,
    ).toBe(true);
    expect(
      SecretInputSchema.safeParse({
        secretName: "db.password",
        title: "Database password",
        value: "secret",
        purpose: "db_connection",
      }).success,
    ).toBe(true);
    expect(
      SecretInputSchema.safeParse({
        secretName: "db.password",
        title: "Wrong scope",
        value: "secret",
        purpose: "agent_value",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate credential keys before run snapshotting", () => {
    const result = EnvironmentCreateSchema.safeParse({
      config: {
        name: "QA",
        initialUrl: "https://app.example.com",
        allowedOrigin: "https://app.example.com",
      },
      secrets: [
        { secretName: "PASSWORD", title: "First", value: "one" },
        { secretName: "PASSWORD", title: "Second", value: "two" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("validates egress port ranges", () => {
    expect(
      WorkspaceEgressRuleInputSchema.safeParse({
        name: "QA API",
        targetKind: "api",
        protocol: "https",
        hostPattern: "api.example.com",
        portFrom: 443,
        portTo: 443,
      }).success,
    ).toBe(true);
    expect(
      WorkspaceEgressRuleInputSchema.safeParse({
        name: "Invalid",
        targetKind: "database",
        protocol: "tcp",
        hostPattern: "db.example.com",
        portFrom: 6000,
        portTo: 5000,
      }).success,
    ).toBe(false);
  });
});
