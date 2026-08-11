import { beforeEach, describe, expect, it, vi } from "vitest";

const egress = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
}));

vi.mock("@/modules/test-execution/egress-policy.service", () => ({
  assertTestExecutionEgressAllowed: egress.assertAllowed,
}));

import { GuardedApiExecutor } from "./guarded-api-executor";

describe("GuardedApiExecutor workspace egress policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    egress.assertAllowed.mockResolvedValue({ ruleId: "rule-1", resolvedAddresses: ["203.0.113.20"] });
  });

  it("re-authorizes the concrete host and port before every redirected fetch hop", async () => {
    const events: string[] = [];
    egress.assertAllowed.mockImplementation(async (target: { host: string }) => {
      events.push(`guard:${target.host}`);
      return { ruleId: "rule-1", resolvedAddresses: ["203.0.113.20"] };
    });
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const target = new URL(String(url));
      events.push(`fetch:${target.hostname}`);
      return target.pathname === "/v1/orders"
        ? new Response(null, { status: 302, headers: { location: "/v1/orders/next" } })
        : new Response("ok", { status: 200 });
    });
    const executor = new GuardedApiExecutor({
      workspaceId: "workspace-1",
      baseUrl: "https://api.example.test/v1/",
      auth: { type: "none" },
      connectionSecrets: new Map(),
      requestTimeoutMs: 1_000,
      signal: new AbortController().signal,
    }, fetchMock as typeof fetch);

    await executor.execute({ method: "GET", path: "orders" });

    expect(egress.assertAllowed).toHaveBeenCalledTimes(2);
    expect(egress.assertAllowed).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      targetKind: "api",
      protocol: "https",
      host: "api.example.test",
      port: 443,
    });
    expect(egress.assertAllowed).toHaveBeenNthCalledWith(2, expect.objectContaining({
      host: "api.example.test",
      port: 443,
    }));
    expect(events).toEqual([
      "guard:api.example.test",
      "fetch:api.example.test",
      "guard:api.example.test",
      "fetch:api.example.test",
    ]);
  });

  it("converts a workspace denial into a policy error before transport", async () => {
    egress.assertAllowed.mockRejectedValue(new Error("denied"));
    const fetchMock = vi.fn();
    const executor = new GuardedApiExecutor({
      workspaceId: "workspace-1",
      baseUrl: "http://api.example.test:8080/v1/",
      auth: { type: "none" },
      connectionSecrets: new Map(),
      requestTimeoutMs: 1_000,
      signal: new AbortController().signal,
    }, fetchMock as typeof fetch);

    await expect(executor.execute({ method: "GET", path: "orders" })).rejects.toMatchObject({
      category: "policy",
      uncertainSideEffect: false,
    });
    expect(egress.assertAllowed).toHaveBeenCalledWith(expect.objectContaining({
      protocol: "http",
      host: "api.example.test",
      port: 8080,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins each production hop to the address returned by that authorization", async () => {
    egress.assertAllowed
      .mockResolvedValueOnce({ ruleId: "rule-1", resolvedAddresses: ["203.0.113.20"] })
      .mockResolvedValueOnce({ ruleId: "rule-1", resolvedAddresses: ["203.0.113.21"] });
    const pinnedRequest = vi.fn(async (url: URL, init: RequestInit, address: string) => {
      void init;
      void address;
      return url.pathname.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "next" } })
        : new Response("ok", { status: 200 });
    });
    const executor = new GuardedApiExecutor({
      workspaceId: "workspace-1",
      baseUrl: "https://api.example.test/v1/",
      auth: { type: "none" },
      connectionSecrets: new Map(),
      requestTimeoutMs: 1_000,
      signal: new AbortController().signal,
    }, undefined, pinnedRequest);

    await executor.execute({ method: "GET", path: "start" });

    expect(pinnedRequest.mock.calls.map((call) => call[2])).toEqual([
      "203.0.113.20",
      "203.0.113.21",
    ]);
    expect(egress.assertAllowed).toHaveBeenCalledTimes(2);
  });
});
