import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { ApiExecutorError, GuardedApiExecutor } from "./guarded-api-executor";
import { checkApiConnection } from "./api-connection-check";
import { authorizeEgressTarget, createEgressAuthorizer, type EgressBoundary } from "./egress-boundary";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function localServer(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return `http://localhost:${address.port}/api/v1/`;
}

describe("GuardedApiExecutor", () => {
  it("pins each authorized hop, keeps requests inside the base path, and redacts credentials", async () => {
    const seen: string[] = [];
    const baseUrl = await localServer((request, response) => {
      seen.push(`${request.url} ${request.headers.authorization}`);
      if (request.url === "/api/v1/start") {
        response.writeHead(302, { location: "/api/v1/end" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "x-secret": "token-secret" });
      response.end(JSON.stringify({ value: "ok", access_token: "token-secret" }));
    });
    const authorized: string[] = [];
    const executor = new GuardedApiExecutor({
      baseUrl,
      auth: { type: "bearer" },
      secrets: new Map([["bearerToken", "token-secret"]]),
      allowWrites: false,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      authorizeTarget: async (url) => {
        authorized.push(url.pathname);
        return { resolvedAddresses: ["127.0.0.1"] };
      },
    });

    const result = await executor.execute({ method: "GET", path: "/start" });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ value: "ok", access_token: "[REDACTED]" });
    expect(result.rawBody).toEqual({ value: "ok", access_token: "token-secret" });
    expect(JSON.stringify(result)).not.toContain("token-secret");
    expect(Object.keys(result)).not.toContain("rawBody");
    expect(authorized).toEqual(["/api/v1/start", "/api/v1/end"]);
    expect(seen).toEqual([
      "/api/v1/start Bearer token-secret",
      "/api/v1/end Bearer token-secret",
    ]);
    await expect(executor.execute({ method: "POST", path: "/end" })).rejects.toMatchObject({ category: "policy" });
    await expect(executor.execute({ method: "GET", path: "/../escape" })).rejects.toMatchObject({ category: "policy" });
    await expect(executor.execute({ method: "GET", path: "//outside.test/" })).rejects.toMatchObject({ category: "policy" });
    expect(authorized).toHaveLength(2);
    expect(ApiExecutorError).toBeTypeOf("function");
  });

  it("rejects header override and marks timed-out writes as uncertain", async () => {
    const baseUrl = await localServer((_request, response) => {
      setTimeout(() => response.end("late"), 100);
    });
    const executor = new GuardedApiExecutor({
      baseUrl, auth: { type: "none" }, secrets: new Map(), allowWrites: true,
      timeoutMs: 10, signal: new AbortController().signal,
      authorizeTarget: async () => ({ resolvedAddresses: ["127.0.0.1"] }),
    });
    await expect(executor.execute({ method: "POST", path: "/write", headers: { Host: "evil.test" } })).rejects.toMatchObject({ code: "forbidden-header", uncertainSideEffect: false });
    await expect(executor.execute({ method: "POST", path: "/write", body: { value: 1 } })).rejects.toMatchObject({ category: "timeout", uncertainSideEffect: true });
  });

  it("obtains OAuth token through separately authorized pinned hop", async () => {
    const calls: string[] = [];
    const baseUrl = await localServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/token") response.end(JSON.stringify({ access_token: "oauth-secret", expires_in: 60 }));
      else response.end(JSON.stringify({ token: request.headers.authorization }));
    });
    const executor = new GuardedApiExecutor({
      baseUrl, auth: { type: "oauth2_client_credentials", tokenUrl: new URL("/token", baseUrl).toString(), clientId: "client" },
      secrets: new Map([["oauthClientSecret", "client-secret"]]), allowWrites: false,
      timeoutMs: 1_000, signal: new AbortController().signal,
      authorizeTarget: async (_url, kind) => { calls.push(kind); return { resolvedAddresses: ["127.0.0.1"] }; },
    });
    const result = await executor.execute({ method: "GET", path: "/items" });
    expect(result.body).toEqual({ token: "[REDACTED]" });
    expect(JSON.stringify(result)).not.toMatch(/client-secret|oauth-secret/);
    expect(calls).toEqual(["oauth", "POST /token", "api", "GET /api/v1/items"]);
  });

  it("checks connectivity and authentication without writes", async () => {
    const methods: string[] = [];
    const baseUrl = await localServer((request, response) => {
      methods.push(request.method ?? "");
      response.writeHead(401);
      response.end();
    });
    const result = await checkApiConnection({
      baseUrl, auth: { type: "none" }, secrets: new Map(), allowWrites: true,
      timeoutMs: 1_000, signal: new AbortController().signal,
      authorizeTarget: async () => ({ resolvedAddresses: ["127.0.0.1"] }),
    });
    expect(result).toMatchObject({ connected: true, authenticated: false });
    expect(methods).toEqual(["HEAD"]);
  });

  it("truncates oversized responses without returning additional bytes", async () => {
    const baseUrl = await localServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("abcdefgh");
    });
    const executor = new GuardedApiExecutor({
      baseUrl, auth: { type: "none" }, secrets: new Map(), allowWrites: false,
      timeoutMs: 1_000, maxResponseBytes: 4, signal: new AbortController().signal,
      authorizeTarget: async () => ({ resolvedAddresses: ["127.0.0.1"] }),
    });
    await expect(executor.execute({ method: "GET", path: "/large" })).resolves.toMatchObject({ body: "abcd", truncated: true });
  });

  it("redacts encoded query credentials and echoed Basic authorization", async () => {
    const baseUrl = await localServer((request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end(`${request.url} ${request.headers.authorization ?? ""}`);
    });
    const common = {
      baseUrl, allowWrites: false, timeoutMs: 1_000,
      signal: new AbortController().signal,
      authorizeTarget: async () => ({ resolvedAddresses: ["127.0.0.1"] }),
    };
    const query = new GuardedApiExecutor({ ...common, auth: { type: "api_key", location: "query", name: "key" }, secrets: new Map([["apiKey", "a+b/c"]]) });
    const queryResult = await query.execute({ method: "GET", path: "/echo" });
    expect(JSON.stringify(queryResult)).not.toMatch(/a\+b\/c|a%2Bb%2Fc/i);
    const basic = new GuardedApiExecutor({ ...common, auth: { type: "basic", username: "user" }, secrets: new Map([["basicPassword", "password-123"]]) });
    const basicResult = await basic.execute({ method: "GET", path: "/echo" });
    expect(JSON.stringify(basicResult)).not.toContain(Buffer.from("user:password-123").toString("base64"));
  });

  it("authorizes exact targets and rejects private addresses without explicit CIDR", async () => {
    const target = { kind: "api" as const, protocol: "http" as const, host: "127.0.0.1", port: 8080 };
    const boundary: EgressBoundary = { targets: [target] };
    await expect(authorizeEgressTarget(boundary, target)).rejects.toThrow("Private egress");
    await expect(authorizeEgressTarget({ ...boundary, privateCidrs: ["127.0.0.0/8"] }, target)).resolves.toEqual({ resolvedAddresses: ["127.0.0.1"] });
    await expect(authorizeEgressTarget({ ...boundary, privateCidrs: ["127.0.0.0/8"] }, { ...target, port: 8081 })).rejects.toThrow("run boundary");
    await expect(authorizeEgressTarget({ targets: [{ ...target, host: "169.254.169.254" }], privateCidrs: ["0.0.0.0/0"] }, { ...target, host: "169.254.169.254" })).rejects.toThrow("denied");
    const authorize = createEgressAuthorizer({ ...boundary, privateCidrs: ["127.0.0.0/8"] });
    await expect(authorize(new URL("http://127.0.0.1:8080/path"), "api")).resolves.toEqual({ resolvedAddresses: ["127.0.0.1"] });
  });
});
