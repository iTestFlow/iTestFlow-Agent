import { describe, expect, it, vi } from "vitest";

import { ApiExecutorError } from "./api-executor.port";
import { GuardedApiExecutor, redactSensitiveData } from "./guarded-api-executor";

function config(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://api.example.test/v1/",
    auth: { type: "none" as const },
    connectionSecrets: new Map<string, string>(),
    requestTimeoutMs: 1_000,
    signal: new AbortController().signal,
    assertTarget: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("GuardedApiExecutor", () => {
  it("keeps requests under the base URL and returns bounded redacted evidence", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      expect(String(url)).toBe("https://api.example.test/v1/orders/42?full=true");
      return new Response(JSON.stringify({ id: 42, token: "secret", nested: { password: "pw" } }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "sid=abc" },
      });
    });
    const executor = new GuardedApiExecutor(config(), fetchMock as typeof fetch);
    const result = await executor.execute({ method: "GET", path: "orders/42", query: { full: true } });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ id: 42, token: "secret" });
    expect(result.safeBody).toEqual({ id: 42, token: "[REDACTED]", nested: { password: "[REDACTED]" } });
    expect(result.headers["set-cookie"]).toBe("[REDACTED]");
  });

  it("resolves a leading operation path beneath a configured base prefix", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      expect(String(url)).toBe("https://api.example.test/api/v1/orders/42");
      return new Response("ok", { status: 200 });
    });
    const executor = new GuardedApiExecutor(config({
      baseUrl: "https://api.example.test/api/v1/",
    }), fetchMock as typeof fetch);

    await executor.execute({ method: "GET", path: "/orders/42" });
  });

  it("rejects path escapes, cross-origin redirects, and environment-owned headers", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }));
    const executor = new GuardedApiExecutor(config(), fetchMock as typeof fetch);
    await expect(executor.execute({ method: "GET", path: "https://evil.test/x" })).rejects.toMatchObject({ category: "policy" });
    await expect(executor.execute({ method: "GET", path: "/v1/orders", headers: { Authorization: "x" } })).rejects.toMatchObject({ category: "policy" });
    await expect(executor.execute({ method: "GET", path: "/v1/orders" })).rejects.toThrow("redirects may not leave");
  });

  it("injects a query API key without exposing it in evidence", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      expect(String(url)).toContain("key=abc123");
      return new Response("ok", { status: 200 });
    });
    const executor = new GuardedApiExecutor(config({
      auth: { type: "api_key", location: "query", name: "key" },
      connectionSecrets: new Map([["api.api_key", "abc123"]]),
    }), fetchMock as typeof fetch);
    const result = await executor.execute({ method: "GET", path: "/v1/orders" });
    expect(result.url).toContain("key=%5BREDACTED%5D");
    expect(result.url).not.toContain("abc123");
  });

  it("marks mutation transport failures as uncertain side effects", async () => {
    const executor = new GuardedApiExecutor(config(), vi.fn(async () => { throw new Error("socket dropped"); }) as typeof fetch);
    const error = await executor.execute({ method: "POST", path: "/v1/orders", body: { id: 1 } }).catch((value) => value);
    expect(error).toBeInstanceOf(ApiExecutorError);
    expect(error).toMatchObject({ category: "transport", uncertainSideEffect: true });
  });

  it("authorizes every redirect hop immediately before transport", async () => {
    const events: string[] = [];
    const assertTarget = vi.fn(async (url: URL) => { events.push(`guard:${url.pathname}`); });
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const path = new URL(String(url)).pathname;
      events.push(`fetch:${path}`);
      return path.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "next" } })
        : new Response("ok", { status: 200 });
    });
    const executor = new GuardedApiExecutor(config({ assertTarget }), fetchMock as typeof fetch);

    await executor.execute({ method: "GET", path: "start" });

    expect(events).toEqual([
      "guard:/v1/start",
      "fetch:/v1/start",
      "guard:/v1/next",
      "fetch:/v1/next",
    ]);
    expect(assertTarget).toHaveBeenCalledTimes(2);
  });

  it("rejects a same-origin read redirect that leaves the configured base pathname", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "/admin/export" },
    }));
    const executor = new GuardedApiExecutor(config(), fetchMock as typeof fetch);

    await expect(executor.execute({ method: "GET", path: "orders" })).rejects.toMatchObject({
      category: "policy",
      uncertainSideEffect: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never follows mutation redirects and marks the already-sent outcome uncertain", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 303,
      headers: { location: "status" },
    }));
    const executor = new GuardedApiExecutor(config(), fetchMock as typeof fetch);

    await expect(executor.execute({ method: "POST", path: "orders", body: { id: 1 } })).rejects.toMatchObject({
      category: "transport",
      uncertainSideEffect: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("follows standard read redirects with the original safe method and treats 304 as terminal", async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      methods.push(String(init?.method));
      const path = new URL(String(url)).pathname;
      return path.endsWith("/start")
        ? new Response(null, { status: 303, headers: { location: "next" } })
        : new Response(null, { status: 304 });
    });
    const executor = new GuardedApiExecutor(config(), fetchMock as typeof fetch);

    const result = await executor.execute({ method: "GET", path: "start" });

    expect(methods).toEqual(["GET", "GET"]);
    expect(result.statusCode).toBe(304);
  });

  it("denies a hop before fetch and reports a policy outcome", async () => {
    const fetchMock = vi.fn();
    const executor = new GuardedApiExecutor(config({
      assertTarget: vi.fn(async () => { throw new Error("denied"); }),
    }), fetchMock as typeof fetch);

    await expect(executor.execute({ method: "GET", path: "orders" })).rejects.toMatchObject({
      category: "policy",
      uncertainSideEffect: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authorizes the OAuth token request and subsequent API request independently", async () => {
    const assertTarget = vi.fn(async (url: URL, kind: "api" | "oauth") => {
      void url;
      void kind;
      return undefined;
    });
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => String(url).includes("oauth.example.test")
      ? new Response(JSON.stringify({ access_token: "issued-token", expires_in: 60 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response("ok", { status: 200 }));
    const executor = new GuardedApiExecutor(config({
      auth: {
        type: "oauth2_client_credentials",
        tokenUrl: "https://oauth.example.test/token",
        clientId: "client",
        scopes: [],
      },
      connectionSecrets: new Map([["api.oauth_client_secret", "secret"]]),
      assertTarget,
    }), fetchMock as typeof fetch);

    await executor.execute({ method: "GET", path: "orders" });

    expect(assertTarget.mock.calls.map(([, kind]) => kind)).toEqual(["oauth", "api"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the request deadline active while reading a response body", async () => {
    const fetchMock = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) =>
      hangingResponse(init?.signal));
    const executor = new GuardedApiExecutor(config({ requestTimeoutMs: 20 }), fetchMock as typeof fetch);

    await expect(executor.execute({ method: "GET", path: "orders" })).rejects.toMatchObject({
      category: "timeout",
      uncertainSideEffect: false,
    });
  });

  it("bounds and times out OAuth response-body reads without claiming a business side effect", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) =>
      String(url).includes("oauth.example.test")
        ? hangingResponse(init?.signal)
        : new Response("ok", { status: 200 }));
    const executor = new GuardedApiExecutor(config({
      requestTimeoutMs: 20,
      auth: {
        type: "oauth2_client_credentials",
        tokenUrl: "https://oauth.example.test/token",
        clientId: "client",
        scopes: [],
      },
      connectionSecrets: new Map([["api.oauth_client_secret", "secret"]]),
    }), fetchMock as typeof fetch);

    await expect(executor.execute({ method: "GET", path: "orders" })).rejects.toMatchObject({
      category: "timeout",
      uncertainSideEffect: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an oversized OAuth token response before parsing it", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) =>
      String(url).includes("oauth.example.test")
        ? new Response(JSON.stringify({ access_token: "x".repeat(70 * 1024) }), { status: 200 })
        : new Response("ok", { status: 200 }));
    const executor = new GuardedApiExecutor(config({
      auth: {
        type: "oauth2_client_credentials",
        tokenUrl: "https://oauth.example.test/token",
        clientId: "client",
        scopes: [],
      },
      connectionSecrets: new Map([["api.oauth_client_secret", "secret"]]),
    }), fetchMock as typeof fetch);

    await expect(executor.execute({ method: "GET", path: "orders" })).rejects.toMatchObject({
      category: "prerequisite",
      uncertainSideEffect: false,
    });
  });
});

describe("redactSensitiveData", () => {
  it("redacts sensitive keys recursively", () => {
    expect(redactSensitiveData([{ apiKey: "x", safe: 1 }])).toEqual([{ apiKey: "[REDACTED]", safe: 1 }]);
  });
});

function hangingResponse(signal?: AbortSignal | null) {
  return new Response(new ReadableStream({
    start(controller) {
      const abort = () => controller.error(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
  }), { status: 200 });
}
