import { describe, expect, it } from "vitest";

import {
  MAX_OPENAPI_OPERATIONS,
  OPENAPI_MANIFEST_VERSION_V1,
  buildOpenApiIntegrationCapabilities,
  normalizeOpenApiDocument,
  OpenApiNormalizationError,
} from "./openapi-contract-normalizer";

describe("normalizeOpenApiDocument", () => {
  it("imports reads and writes with method-derived safety classes and keeps secrets out", () => {
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
          delete: { operationId: "deleteOrder" },
          post: { operationId: "createOrder", requestBody: { content: { secret: "never-store" } } },
        },
        "//evil.example.test/path": { get: { operationId: "unsafe" } },
        "/reset/{token}": { get: { operationId: "credentialInPath" } },
      },
    });

    expect(normalized.schemaVersion).toBe("itestflow.openapi.v2");
    expect(normalized.operations).toHaveLength(4);
    expect(normalized.operations.map((operation) => [operation.operationId, operation.safetyClass])).toEqual([
      ["getOrder", "read"],
      ["headOrder", "read"],
      ["createOrder", "mutation"],
      ["deleteOrder", "mutation"],
    ]);
    expect(normalized.operations[0]).toMatchObject({
      operationId: "getOrder",
      method: "GET",
      path: "/orders/{orderId}",
      pathParameters: ["orderId"],
      queryParameters: [
        { name: "includeHistory", required: false },
        { name: "limit", required: true },
      ],
      requestBody: null,
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
    // A POST without a JSON body declaration imports with no body channel.
    expect(normalized.operations[2]).toMatchObject({ method: "POST", requestBody: null });
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("never-store");
    expect(serialized).not.toContain("securitySchemes");
    expect(serialized).not.toContain("raw description");
  });

  it("imports JSON request bodies through the bounded local ref resolver", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      components: {
        schemas: {
          NewOrder: {
            type: "object",
            description: "stripped",
            properties: {
              sku: { type: "string", example: "stripped" },
              quantity: { $ref: "#/components/schemas/Quantity" },
            },
            required: ["sku"],
          },
          Quantity: { type: "integer", minimum: 1 },
        },
        requestBodies: {
          NewOrderBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/NewOrder" } } },
          },
        },
      },
      paths: {
        "/orders": {
          post: { operationId: "createOrder", requestBody: { $ref: "#/components/requestBodies/NewOrderBody" } },
          put: {
            operationId: "replaceOrders",
            requestBody: {
              content: { "application/json; charset=utf-8": { schema: { type: "object" } } },
            },
          },
        },
      },
    });

    expect(normalized.operations[0]).toMatchObject({
      operationId: "createOrder",
      safetyClass: "mutation",
      requestBody: {
        contentType: "application/json",
        required: true,
        schema: {
          type: "object",
          properties: {
            sku: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
          },
          required: ["sku"],
        },
      },
    });
    expect(JSON.stringify(normalized)).not.toContain("stripped");
    expect(normalized.operations[1]).toMatchObject({
      operationId: "replaceOrders",
      requestBody: { contentType: "application/json", required: false },
    });
  });

  it("drops operations whose required body, header, or cookie cannot be imported safely", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      paths: {
        "/import-me": { get: { operationId: "keepMe" } },
        "/external-body": {
          post: {
            operationId: "externalBody",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "https://evil.example/schema.json" } } },
            },
          },
        },
        "/xml-only": {
          post: {
            operationId: "xmlOnly",
            requestBody: { required: true, content: { "application/xml": { schema: { type: "object" } } } },
          },
        },
        "/needs-auth-header": {
          get: {
            operationId: "needsAuth",
            parameters: [{ in: "header", name: "Authorization", required: true, schema: { type: "string" } }],
          },
        },
        "/needs-cookie": {
          get: {
            operationId: "needsCookie",
            parameters: [{ in: "cookie", name: "session", required: true, schema: { type: "string" } }],
          },
        },
      },
    });

    expect(normalized.operations.map((operation) => operation.operationId)).toEqual(["keepMe"]);
    expect(normalized.droppedOperationCount).toBe(4);
  });

  it("imports non-sensitive headers and excludes optional sensitive ones", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            parameters: [
              { in: "header", name: "X-Request-Id", required: true, schema: { type: "string" } },
              { in: "header", name: "X-Tenant", schema: { type: "string" } },
              { in: "header", name: "Authorization", schema: { type: "string" } },
              { in: "cookie", name: "session", schema: { type: "string" } },
            ],
          },
        },
      },
    });

    expect(normalized.operations[0].headerParameters).toEqual([
      { name: "X-Request-Id", property: "header_x_request_id", required: true },
      { name: "X-Tenant", property: "header_x_tenant", required: false },
    ]);
    expect(normalized.operations[0].parameterSchema.properties).toMatchObject({
      header_x_request_id: { type: "string" },
      header_x_tenant: { type: "string" },
    });
    expect(normalized.operations[0].parameterSchema.required).toContain("header_x_request_id");
    expect(JSON.stringify(normalized.operations[0])).not.toContain("Authorization");
  });

  it("generates deterministic safe IDs and operation keys per method", () => {
    const document = {
      openapi: "3.0.3",
      paths: { "/users/{user_id}": { get: { operationId: "not a safe id" }, delete: {} } },
    };
    expect(normalizeOpenApiDocument(document)).toEqual(normalizeOpenApiDocument(document));
    expect(normalizeOpenApiDocument(document).operations[0]).toMatchObject({
      operationId: expect.stringMatching(/^get_users_by_user_id_/),
      stableKey: expect.stringMatching(/^openapi\.get\.[0-9a-f]{16}$/),
    });
    expect(normalizeOpenApiDocument(document).operations[1]).toMatchObject({
      stableKey: expect.stringMatching(/^openapi\.delete\.[0-9a-f]{16}$/),
      safetyClass: "mutation",
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

  it("resolves $ref parameter schemas and parameter objects locally", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      components: {
        schemas: { PageSize: { type: "integer" } },
        parameters: {
          PageParam: { in: "query", name: "page", required: true, schema: { $ref: "#/components/schemas/PageSize" } },
        },
      },
      paths: {
        "/items": {
          get: { operationId: "listItems", parameters: [{ $ref: "#/components/parameters/PageParam" }] },
        },
      },
    });
    expect(normalized.operations[0].parameterSchema.properties).toMatchObject({ page: { type: "integer" } });
    expect(normalized.operations[0].parameterSchema.required).toEqual(["page"]);
  });

  it("maps a frozen v2 revision into pinned runtime capabilities", () => {
    const normalized = normalizeOpenApiDocument({
      openapi: "3.0.3",
      components: {
        schemas: { Order: { type: "object", properties: { sku: { type: "string" } } } },
      },
      paths: {
        "/orders/{id}": { get: { operationId: "getOrder" } },
        "/orders": {
          post: {
            operationId: "createOrder",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
            },
          },
        },
      },
    });
    const capabilities = buildOpenApiIntegrationCapabilities("tacr_revision_1", normalized);
    expect(capabilities).toHaveLength(2);
    expect(capabilities.find((capability) => capability.name === "getOrder")).toMatchObject({
      id: expect.stringMatching(/^tacr_revision_1:openapi\.get\.[0-9a-f]{16}$/),
      layer: "api",
      safetyClass: "read",
      approved: true,
      parameterSchema: expect.objectContaining({ required: ["id"] }),
      definition: expect.objectContaining({ method: "GET", path: "/orders/{id}", query: {} }),
    });
    expect(capabilities.find((capability) => capability.name === "createOrder")).toMatchObject({
      safetyClass: "mutation",
      approved: true,
      requestBodySchema: expect.objectContaining({ type: "object" }),
      requestBodyRequired: true,
      definition: expect.objectContaining({ method: "POST", contentType: "application/json" }),
    });
  });

  it("keeps projecting historical v1 manifests byte-for-byte", () => {
    const v1Manifest = {
      schemaVersion: OPENAPI_MANIFEST_VERSION_V1,
      openapiVersion: "3.0.3",
      operations: [
        {
          stableKey: "openapi.get.0123456789abcdef",
          operationId: "getOrder",
          displayName: "getOrder",
          method: "GET",
          path: "/orders/{id}",
          pathParameters: ["id"],
          queryParameters: [{ name: "expand", required: false }],
          parameterSchema: {
            type: "object",
            properties: { id: { type: "string" }, expand: { type: "boolean" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      ],
    };
    expect(buildOpenApiIntegrationCapabilities("tacr_v1", v1Manifest)).toEqual([
      expect.objectContaining({
        id: "tacr_v1:openapi.get.0123456789abcdef",
        safetyClass: "read",
        approved: true,
        definition: expect.objectContaining({
          method: "GET",
          path: "/orders/{id}",
          query: { expand: "{{param:expand}}" },
        }),
      }),
    ]);
    // A v1 manifest can never smuggle a mutation method through the v1 reader.
    const tampered = {
      ...v1Manifest,
      operations: [{ ...v1Manifest.operations[0], method: "POST", stableKey: "openapi.post.0123456789abcdef" }],
    };
    expect(() => buildOpenApiIntegrationCapabilities("tacr_v1", tampered)).toThrow(
      "frozen OpenAPI operation manifest is invalid",
    );
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
      // Tampered safety class: a GET stamped as mutation must be rejected.
      ["revision", withOperation({ safetyClass: "mutation" })],
      // Tampered method without a matching class must be rejected.
      ["revision", withOperation({ method: "POST", stableKey: operation.stableKey.replace(".get.", ".post.") })],
      ["revision", withOperation({ path: "https://evil.example/path" })],
      ["revision", withOperation({ parameterSchema: null })],
      ["revision", withOperation({ pathParameters: [42] })],
      ["revision", withOperation({ queryParameters: [{ name: "bad-name", required: false }] })],
      ["revision", withOperation({ queryParameters: [{ name: "token", required: true }] })],
      ["revision", withOperation({ queryParameters: [{ name: "expand" }] })],
      ["revision", withOperation({ queryParameters: [{ name: "id", required: false }] })],
      // Header entries must be structurally sound and non-sensitive.
      ["revision", withOperation({ headerParameters: [{ name: "Authorization", property: "header_authorization", required: true }] })],
      ["revision", withOperation({ headerParameters: [{ name: "X-Ok", property: "not safe!", required: false }] })],
      // Body channel must be JSON with a schema object.
      ["revision", withOperation({ requestBody: { contentType: "text/plain", required: true, schema: {} } })],
      ["revision", withOperation({ requestBody: { contentType: "application/json", required: "yes", schema: {} } })],
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
    expect(() => normalizeOpenApiDocument({
      openapi: "3.0.3",
      paths: { "/items": { get: { parameters: [{ in: "query", name: "token", required: true, schema: { type: "string" } }] } } },
    })).toThrow("no importable operations");

    const paths = Object.fromEntries(Array.from({ length: MAX_OPENAPI_OPERATIONS + 1 }, (_, index) => [
      `/items/${index}`,
      { get: { operationId: `getItem${index}` } },
    ]));
    expect(() => normalizeOpenApiDocument({ openapi: "3.0.3", paths })).toThrow("operation limit");
  });
});
