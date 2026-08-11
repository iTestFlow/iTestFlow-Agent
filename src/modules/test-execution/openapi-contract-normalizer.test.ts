import { describe, expect, it } from "vitest";

import {
  MAX_OPENAPI_OPERATIONS,
  buildOpenApiIntegrationCapabilities,
  normalizeOpenApiDocument,
  OpenApiNormalizationError,
} from "./openapi-contract-normalizer";

describe("normalizeOpenApiDocument", () => {
  it("keeps only safe GET/HEAD manifests and path parameters", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.1.0",
      info: { title: "Orders", description: "raw description must not survive" },
      servers: [{ url: "https://other.example.test" }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", secret: "never-store" } },
      },
      paths: {
        "/orders/{orderId}": {
          parameters: [{ in: "path", name: "orderId", schema: { type: "integer" } }],
          get: {
            operationId: "getOrder",
            security: [{ bearerAuth: [] }],
            parameters: [
              { in: "query", name: "apiKey", schema: { type: "string" } },
              { in: "query", name: "includeHistory", schema: { type: "boolean" } },
              { in: "query", name: "limit", required: true, schema: { type: "integer" } },
            ],
          },
          head: { operationId: "headOrder" },
          post: { operationId: "createOrder", requestBody: { content: { secret: "never-store" } } },
        },
        "//evil.example.test/path": { get: { operationId: "unsafe" } },
        "/reset/{token}": { get: { operationId: "credentialInPath" } },
      },
    });

    expect(normalized.operations).toHaveLength(2);
    expect(normalized.operations[0]).toMatchObject({
      operationId: "getOrder",
      method: "GET",
      path: "/orders/{orderId}",
      pathParameters: ["orderId"],
      queryParameters: [
        { name: "includeHistory", required: false },
        { name: "limit", required: true },
      ],
      parameterSchema: {
        properties: {
          orderId: { type: "integer" },
          includeHistory: { type: "boolean" },
          limit: { type: "integer" },
        },
        required: ["orderId", "limit"],
        additionalProperties: false,
      },
    });
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("never-store");
    expect(serialized).not.toContain("securitySchemes");
    expect(serialized).not.toContain("createOrder");
    expect(serialized).not.toContain("raw description");
  });

  it("generates deterministic safe IDs and operation keys", () => {
    const document = {
      openapi: "3.0.3",
      paths: { "/users/{user_id}": { get: { operationId: "not a safe id" } } },
    };
    expect(normalizeOpenApiDocument(document)).toEqual(normalizeOpenApiDocument(document));
    expect(normalizeOpenApiDocument(document).operations[0]).toMatchObject({
      operationId: expect.stringMatching(/^get_users_by_user_id_/),
      stableKey: expect.stringMatching(/^openapi\.get\.[0-9a-f]{16}$/),
    });
  });

  it("applies operation parameter overrides and keeps only supported scalar query inputs", () => {
    const queryParameters = Array.from({ length: 51 }, (_, index) => ({
      in: "query",
      name: `q${index}`,
      schema: { type: "string" },
    }));
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      paths: {
        "/search/{id}": {
          parameters: [
            { in: "path", name: "id", schema: { type: "string" } },
            { in: "query", name: "page", schema: { type: "string" } },
            { in: "header", name: "X-Ignored", schema: { type: "string" } },
            null,
          ],
          get: {
            operationId: "search",
            parameters: [
              { in: "path", name: "id", schema: { type: "integer", enum: [1, 2] } },
              { in: "query", name: "page", required: true, schema: { type: "integer", enum: [1, 2] } },
              { in: "query", name: "ratio", schema: { type: "number", enum: [1, 2.5] } },
              { in: "query", name: "active", schema: { type: "boolean", enum: [true, false] } },
              { in: "query", name: "mode", schema: { type: "string", enum: ["brief", "full"] } },
              { in: "query", name: "tags", schema: { type: "array", items: { type: "string" } } },
              { in: "query", name: "api_token", schema: { type: "string" } },
            ],
          },
          head: { operationId: "search" },
        },
        "/required-credential": {
          get: { parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }] },
        },
        "/required-complex": {
          get: { parameters: [{ in: "query", name: "filter", required: true, schema: { type: "object" } }] },
        },
        "/ambiguous/{id}": {
          get: { parameters: [{ in: "query", name: "id", required: true, schema: { type: "string" } }] },
        },
        "/too-many": { get: { parameters: queryParameters } },
        "/deprecated": { get: { deprecated: true } },
        "/not-an-item": null,
      },
    });

    expect(normalized.operations).toHaveLength(2);
    expect(normalized.operations.map((operation) => operation.operationId)).toEqual(["search", "search_2"]);
    expect(normalized.operations[0]).toMatchObject({
      queryParameters: [
        { name: "active", required: false },
        { name: "mode", required: false },
        { name: "page", required: true },
        { name: "ratio", required: false },
      ],
      parameterSchema: {
        properties: {
          id: { type: "integer", enum: [1, 2] },
          active: { type: "boolean", enum: [true, false] },
          mode: { type: "string", enum: ["brief", "full"] },
          page: { type: "integer", enum: [1, 2] },
          ratio: { type: "number", enum: [1, 2.5] },
        },
        required: ["id", "page"],
      },
    });
  });

  it("maps a frozen revision into pinned runtime capabilities", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      paths: { "/orders/{id}": { get: { operationId: "getOrder" } } },
    });
    expect(buildOpenApiIntegrationCapabilities("tacr_revision_1", normalized)).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^tacr_revision_1:openapi\.get\.[0-9a-f]{16}$/),
        name: "getOrder",
        layer: "api",
        safetyClass: "read",
        approved: true,
        parameterSchema: expect.objectContaining({ required: ["id"] }),
        definition: expect.objectContaining({ method: "GET", path: "/orders/{id}", query: {} }),
      }),
    ]);
  });

  it("fails closed when a frozen manifest is missing or has been tampered with", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      paths: {
        "/orders/{id}": {
          get: {
            operationId: "getOrder",
            parameters: [{ in: "query", name: "expand", schema: { type: "boolean" } }],
          },
        },
      },
    });
    const operation = normalized.operations[0];
    const withOperation = (changes: Record<string, unknown>) => ({
      ...normalized,
      operations: [{ ...operation, ...changes }],
    });
    const invalid: Array<[string, unknown]> = [
      ["", normalized],
      ["r".repeat(121), normalized],
      ["revision", null],
      ["revision", { ...normalized, schemaVersion: "unknown" }],
      ["revision", { ...normalized, operations: [] }],
      ["revision", withOperation({ stableKey: "unsafe" })],
      ["revision", withOperation({ operationId: 42 })],
      ["revision", withOperation({ displayName: "" })],
      ["revision", withOperation({ method: "POST" })],
      ["revision", withOperation({ path: "https://evil.example/path" })],
      ["revision", withOperation({ parameterSchema: null })],
      ["revision", withOperation({ pathParameters: [42] })],
      ["revision", withOperation({ queryParameters: [{ name: "bad-name", required: false }] })],
      ["revision", withOperation({ queryParameters: [{ name: "token", required: true }] })],
      ["revision", withOperation({ queryParameters: [{ name: "expand" }] })],
      ["revision", withOperation({ queryParameters: [{ name: "id", required: false }] })],
    ];

    for (const [revisionId, manifest] of invalid) {
      expect(() => buildOpenApiIntegrationCapabilities(revisionId, manifest)).toThrow(
        "frozen OpenAPI operation manifest is invalid",
      );
    }
  });

  it("rejects unsupported, empty, and oversized documents", () => {
    expect(() => normalizeOpenApiDocument({ swagger: "2.0", paths: {} }))
      .toThrow(OpenApiNormalizationError);
    expect(() => normalizeOpenApiDocument({ openapi: "3.0.3" })).toThrow("paths object");
    expect(() => normalizeOpenApiDocument({ openapi: "3.0.3", paths: { "/items": { post: {} } } }))
      .toThrow("no safe GET or HEAD");

    const paths = Object.fromEntries(Array.from({ length: MAX_OPENAPI_OPERATIONS + 1 }, (_, index) => [
      `/items/${index}`,
      { get: { operationId: `getItem${index}` } },
    ]));
    expect(() => normalizeOpenApiDocument({ openapi: "3.0.3", paths })).toThrow("operation read-only limit");
  });
});
