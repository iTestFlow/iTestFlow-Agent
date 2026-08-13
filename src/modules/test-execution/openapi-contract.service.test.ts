import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEgress: vi.fn(),
}));

vi.mock("./egress-policy.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./egress-policy.service")>();
  return { ...actual, assertBoundaryEgressAllowed: mocks.assertEgress };
});

import type { ExecutionBoundary } from "./execution-boundary";

import {
  fetchAndNormalizeSameOriginOpenApi,
  MAX_OPENAPI_DOCUMENT_BYTES,
  OpenApiContractImportError,
  setOpenApiContractFetchForTests,
} from "./openapi-contract.service";

const sourceUrl = "https://api.example.test/openapi.json";
const boundary: ExecutionBoundary = {
  version: "itestflow.boundary.v1",
  targets: [
    { kind: "api", protocol: "https", host: "api.example.test", port: 443 },
    { kind: "openapi", protocol: "https", host: "api.example.test", port: 443 },
  ],
};
const baseInput = {
  boundary,
  baseUrl: "https://api.example.test/v1",
  sourceUrl,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertEgress.mockResolvedValue({ resolvedAddresses: ["203.0.113.10"] });
});

afterEach(() => {
  setOpenApiContractFetchForTests(null);
});

describe("fetchAndNormalizeSameOriginOpenApi", () => {
  it("authorizes the OpenAPI target and fetches JSON without credentials or redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      openapi: "3.0.3",
      paths: { "/orders/{id}": { get: { operationId: "getOrder" } } },
    }), { headers: { "content-type": "application/json" } }));
    setOpenApiContractFetchForTests(fetchMock);

    const normalized = await fetchAndNormalizeSameOriginOpenApi(baseInput);

    expect(normalized.operations).toHaveLength(1);
    expect(mocks.assertEgress).toHaveBeenCalledWith(boundary, {
      targetKind: "openapi",
      protocol: "https",
      host: "api.example.test",
      port: 443,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(sourceUrl),
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects cross-origin/query URLs, redirects, and oversized streaming bodies", async () => {
    await expect(fetchAndNormalizeSameOriginOpenApi({
      ...baseInput,
      sourceUrl: "https://other.example.test/openapi.json",
    })).rejects.toMatchObject({ status: 422 });
    await expect(fetchAndNormalizeSameOriginOpenApi({
      ...baseInput,
      sourceUrl: `${sourceUrl}?token=secret`,
    })).rejects.toMatchObject({ status: 422 });
    expect(mocks.assertEgress).not.toHaveBeenCalled();

    setOpenApiContractFetchForTests(vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://api.example.test/elsewhere.json" },
    })));
    await expect(fetchAndNormalizeSameOriginOpenApi(baseInput)).rejects.toThrow("redirects are not allowed");

    setOpenApiContractFetchForTests(vi.fn(async () => new Response(
      new Uint8Array(MAX_OPENAPI_DOCUMENT_BYTES + 1),
      { headers: { "content-type": "application/json" } },
    )));
    await expect(fetchAndNormalizeSameOriginOpenApi(baseInput)).rejects.toMatchObject({ status: 413 });
  });

  it("aborts a stalled fetch at the configured timeout", async () => {
    setOpenApiContractFetchForTests(vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));

    await expect(fetchAndNormalizeSameOriginOpenApi({ ...baseInput, timeoutMs: 5 }))
      .rejects.toEqual(expect.objectContaining<Partial<OpenApiContractImportError>>({ status: 504 }));
  });

  it("propagates caller cancellation into an in-flight fetch", async () => {
    const controller = new AbortController();
    setOpenApiContractFetchForTests(vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));

    const pending = fetchAndNormalizeSameOriginOpenApi({
      ...baseInput,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort(new DOMException("request canceled", "AbortError"));

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<OpenApiContractImportError>>({ status: 408 }),
    );
  });
});
