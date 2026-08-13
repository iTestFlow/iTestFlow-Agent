import { describe, expect, it } from "vitest";

import { deriveExecutionBoundary, EXECUTION_BOUNDARY_VERSION } from "./execution-boundary";

describe("deriveExecutionBoundary", () => {
  it("derives api + openapi targets from the API base URL", () => {
    const boundary = deriveExecutionBoundary({
      api: { baseUrl: "https://api.example.test/v1", auth: { type: "none" } },
    });
    expect(boundary.version).toBe(EXECUTION_BOUNDARY_VERSION);
    expect(boundary.targets).toEqual([
      { kind: "api", protocol: "https", host: "api.example.test", port: 443 },
      { kind: "openapi", protocol: "https", host: "api.example.test", port: 443 },
    ]);
  });

  it("uses the explicit port and http protocol when configured", () => {
    const boundary = deriveExecutionBoundary({
      api: { baseUrl: "http://api.internal.test:8080/v2/", auth: { type: "bearer" } },
    });
    expect(boundary.targets).toContainEqual({
      kind: "api",
      protocol: "http",
      host: "api.internal.test",
      port: 8080,
    });
  });

  it("adds an oauth target for client-credentials token URLs, deduplicated against the API origin", () => {
    const boundary = deriveExecutionBoundary({
      api: {
        baseUrl: "https://api.example.test/v1",
        auth: { type: "oauth2_client_credentials", tokenUrl: "https://login.example.test/oauth/token" },
      },
    });
    expect(boundary.targets).toContainEqual({
      kind: "oauth",
      protocol: "https",
      host: "login.example.test",
      port: 443,
    });
  });

  it("derives a tcp database target", () => {
    const boundary = deriveExecutionBoundary({
      database: { host: "DB.Example.Test", port: 5432 },
    });
    expect(boundary.targets).toEqual([
      { kind: "database", protocol: "tcp", host: "db.example.test", port: 5432 },
    ]);
  });

  it("normalizes IPv6 and IDN hosts", () => {
    const boundary = deriveExecutionBoundary({
      api: { baseUrl: "https://[2001:DB8::5]:8443/api", auth: { type: "none" } },
      database: { host: "TÄST.example", port: 1433 },
    });
    expect(boundary.targets).toContainEqual({
      kind: "api",
      protocol: "https",
      host: "2001:db8::5",
      port: 8443,
    });
    expect(boundary.targets).toContainEqual({
      kind: "database",
      protocol: "tcp",
      host: "xn--tst-qla.example",
      port: 1433,
    });
  });

  it("returns an empty boundary for UI-only environments", () => {
    expect(deriveExecutionBoundary({}).targets).toEqual([]);
    expect(deriveExecutionBoundary({ api: null, database: null }).targets).toEqual([]);
  });

  it("skips underivable entries instead of throwing (fail-closed)", () => {
    const boundary = deriveExecutionBoundary({
      api: { baseUrl: "not a url", auth: { type: "none" } },
      database: { host: "db.example.test", port: 0 },
    });
    expect(boundary.targets).toEqual([]);
  });

  it("deduplicates identical targets", () => {
    const boundary = deriveExecutionBoundary({
      api: {
        baseUrl: "https://api.example.test/",
        // Token endpoint on the same origin must not produce a duplicate api entry.
        auth: { type: "oauth2_client_credentials", tokenUrl: "https://api.example.test/token" },
      },
    });
    const keys = boundary.targets.map((t) => `${t.kind}|${t.protocol}|${t.host}|${t.port}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(boundary.targets).toHaveLength(3); // api, openapi, oauth — same origin, distinct kinds
  });
});
