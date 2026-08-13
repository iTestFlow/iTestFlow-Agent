import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertBoundaryEgressAllowed,
  setTestExecutionEgressResolverForTests,
  TestExecutionEgressDeniedError,
  type EgressBoundaryTarget,
} from "./egress-policy.service";

const apiTarget: EgressBoundaryTarget = {
  kind: "api",
  protocol: "https",
  host: "api.example.test",
  port: 443,
};
const dbTarget: EgressBoundaryTarget = {
  kind: "database",
  protocol: "tcp",
  host: "db.example.test",
  port: 5432,
};
const boundary = { targets: [apiTarget, dbTarget] };

const apiRequest = { targetKind: "api" as const, protocol: "https" as const, host: "api.example.test", port: 443 };
const dbRequest = { targetKind: "database" as const, protocol: "tcp" as const, host: "db.example.test", port: 5432 };

describe("assertBoundaryEgressAllowed", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    setTestExecutionEgressResolverForTests(async () => ["203.0.113.42"]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setTestExecutionEgressResolverForTests(null);
  });

  it("authorizes an exact boundary match and returns the pinned addresses", async () => {
    setTestExecutionEgressResolverForTests(async () => ["203.0.113.42", "198.51.100.8"]);
    await expect(assertBoundaryEgressAllowed(boundary, apiRequest)).resolves.toEqual({
      resolvedAddresses: ["203.0.113.42", "198.51.100.8"],
    });
  });

  it("denies hosts, ports, kinds, and protocols outside the boundary", async () => {
    await expect(assertBoundaryEgressAllowed(boundary, { ...apiRequest, host: "other.example.test" }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
    await expect(assertBoundaryEgressAllowed(boundary, { ...apiRequest, port: 8443 }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
    await expect(assertBoundaryEgressAllowed(boundary, { ...apiRequest, targetKind: "oauth" }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
    await expect(assertBoundaryEgressAllowed(boundary, { ...apiRequest, protocol: "http" }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
    await expect(assertBoundaryEgressAllowed({ targets: [] }, apiRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });

  it("enforces kind/protocol coherence and port validity before matching", async () => {
    await expect(assertBoundaryEgressAllowed(boundary, { ...dbRequest, protocol: "https" }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
    await expect(assertBoundaryEgressAllowed(boundary, { ...apiRequest, protocol: "tcp" }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
    await expect(assertBoundaryEgressAllowed(boundary, { ...apiRequest, port: 0 }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });

  it("matches hosts case-insensitively with normalization", async () => {
    await expect(assertBoundaryEgressAllowed(boundary, { ...apiRequest, host: "API.Example.Test." }))
      .resolves.toEqual({ resolvedAddresses: ["203.0.113.42"] });
  });

  it("denies private resolutions by default", async () => {
    setTestExecutionEgressResolverForTests(async () => ["10.20.30.40"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toThrow(/private, loopback, or local network/);

    setTestExecutionEgressResolverForTests(async () => ["127.0.0.1"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    setTestExecutionEgressResolverForTests(async () => ["fd00::5"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });

  it("allows a private resolution inside a listed deployment CIDR", async () => {
    vi.stubEnv("TEST_EXECUTION_PRIVATE_NETWORK_CIDRS", "10.20.0.0/16, 192.168.50.0/24");
    setTestExecutionEgressResolverForTests(async () => ["10.20.30.40"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest)).resolves.toEqual({
      resolvedAddresses: ["10.20.30.40"],
    });

    setTestExecutionEgressResolverForTests(async () => ["10.99.0.1"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });

  it("requires loopback to be explicitly listed", async () => {
    setTestExecutionEgressResolverForTests(async () => ["127.0.0.1"]);
    vi.stubEnv("TEST_EXECUTION_PRIVATE_NETWORK_CIDRS", "10.0.0.0/8");
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    vi.stubEnv("TEST_EXECUTION_PRIVATE_NETWORK_CIDRS", "127.0.0.1");
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest)).resolves.toEqual({
      resolvedAddresses: ["127.0.0.1"],
    });
  });

  it("treats localhost-style names as restricted even with public resolutions", async () => {
    const localBoundary = {
      targets: [{ ...dbTarget, host: "db.localhost" }],
    };
    setTestExecutionEgressResolverForTests(async () => ["203.0.113.42"]);
    await expect(assertBoundaryEgressAllowed(localBoundary, { ...dbRequest, host: "db.localhost" }))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    vi.stubEnv("TEST_EXECUTION_PRIVATE_NETWORK_CIDRS", "203.0.113.42");
    await expect(assertBoundaryEgressAllowed(localBoundary, { ...dbRequest, host: "db.localhost" }))
      .resolves.toEqual({ resolvedAddresses: ["203.0.113.42"] });
  });

  it("never allows metadata, link-local, multicast, or unspecified addresses — even when listed", async () => {
    vi.stubEnv(
      "TEST_EXECUTION_PRIVATE_NETWORK_CIDRS",
      "169.254.0.0/16, 224.0.0.0/4, 0.0.0.0/0, ::/0",
    );
    for (const address of ["169.254.169.254", "224.0.0.5", "0.0.0.0", "255.255.255.255", "fe80::1", "ff02::1", "::"]) {
      setTestExecutionEgressResolverForTests(async () => [address]);
      await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
        .rejects.toThrow(/link-local, multicast, or reserved/);
    }
  });

  it("hard-denies transitional IPv6 forms embedding hard-denied IPv4 addresses", async () => {
    setTestExecutionEgressResolverForTests(async () => ["::ffff:169.254.169.254"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toThrow(/link-local, multicast, or reserved/);
  });

  it("covers IPv4-mapped IPv6 aliases through the IPv4 allowlist, but not other transitional forms", async () => {
    vi.stubEnv("TEST_EXECUTION_PRIVATE_NETWORK_CIDRS", "10.0.0.0/8");
    setTestExecutionEgressResolverForTests(async () => ["::ffff:10.1.2.3"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest)).resolves.toEqual({
      resolvedAddresses: ["::ffff:10.1.2.3"],
    });

    // NAT64-embedded private IPv4 routes through a translator: requires an
    // explicit IPv6 listing, so the IPv4 entry alone must not cover it.
    setTestExecutionEgressResolverForTests(async () => ["64:ff9b::10.1.2.3"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });

  it("denies mixed public/private resolutions unless the private address is listed", async () => {
    setTestExecutionEgressResolverForTests(async () => ["203.0.113.42", "10.0.0.5"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    vi.stubEnv("TEST_EXECUTION_PRIVATE_NETWORK_CIDRS", "10.0.0.0/8");
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest)).resolves.toEqual({
      resolvedAddresses: ["203.0.113.42", "10.0.0.5"],
    });
  });

  it("ignores malformed allowlist entries fail-closed", async () => {
    vi.stubEnv("TEST_EXECUTION_PRIVATE_NETWORK_CIDRS", "not-a-cidr, 10.0.0.0/33, 10.0.0.0/8/8, evil.example.com");
    setTestExecutionEgressResolverForTests(async () => ["10.0.0.5"]);
    await expect(assertBoundaryEgressAllowed(boundary, dbRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });

  it("denies unresolvable hosts and invalid DNS responses", async () => {
    setTestExecutionEgressResolverForTests(async () => { throw new Error("NXDOMAIN"); });
    await expect(assertBoundaryEgressAllowed(boundary, apiRequest))
      .rejects.toThrow(/could not be resolved safely/);

    setTestExecutionEgressResolverForTests(async () => ["not-an-ip"]);
    await expect(assertBoundaryEgressAllowed(boundary, apiRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);

    setTestExecutionEgressResolverForTests(async () => []);
    await expect(assertBoundaryEgressAllowed(boundary, apiRequest))
      .rejects.toBeInstanceOf(TestExecutionEgressDeniedError);
  });
});
