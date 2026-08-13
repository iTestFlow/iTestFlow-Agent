import { describe, expect, it } from "vitest";

import {
  describeMultiLayerAction,
  validateCapabilityParameterSchema,
  validateCapabilityParameters,
  validateCapabilityRequestBody,
  validateMultiLayerDecision,
  type IntegrationCapability,
  type MultiLayerAction,
} from "./multi-layer-action";

const apiMutation: IntegrationCapability = {
  id: "api-create-order-v1",
  name: "createOrder",
  layer: "api",
  safetyClass: "mutation",
  approved: true,
  parameterSchema: {},
  definition: { method: "POST", path: "/orders" },
};
const dbMutation: IntegrationCapability = {
  id: "db-mark-order-v1",
  name: "markOrder",
  layer: "db",
  safetyClass: "mutation",
  approved: true,
  driver: "postgres",
  parameterSchema: {},
  definition: { sql: "UPDATE orders SET status = :status WHERE id = :id" },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    layerHint: "auto" as const,
    configuredLayers: new Set(["ui", "api", "db"] as const),
    snapshotRefs: new Set(["e1"]),
    allowedOrigin: "https://app.example.test",
    allowedApiRequests: new Set(["GET /orders/42?full=true"]),
    secretNames: ["USER_PASSWORD"],
    captureNames: ["orderId"],
    capabilities: new Map([[apiMutation.id, apiMutation], [dbMutation.id, dbMutation]]),
    databaseDriver: "postgres" as const,
    ...overrides,
  };
}

describe("validateMultiLayerDecision", () => {
  it("keeps compact UI actions behind live snapshot validation", () => {
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "click",
      argumentsJson: JSON.stringify({ ref: "e1", elementDescription: "Save" }),
    }, context()).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "click",
      argumentsJson: JSON.stringify({ ref: "invented" }),
    }, context()).kind).toBe("invalid");
  });

  it("allows only exact frozen method+path requests for ad-hoc API calls", () => {
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42?full=true" }),
    }, context()).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42", query: { full: true } }),
    }, context()).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42", query: { full: false, admin: true } }),
    }, context()).kind).toBe("action");
    // Approval authorizes the work the step needs against the configured
    // target, so a path the step did not spell out is no longer refused.
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/booking" }),
    }, context()).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42?full=true", headers: { Authorization: "x" } }),
    }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42?full=true", headers: { "X-HTTP-Method-Override": "DELETE" } }),
    }, context()).kind).toBe("invalid");
  });

  it("matches explicit mutation requests by method and rejects bodies on GET/HEAD", () => {
    const postAllowed = context({ allowedApiRequests: new Set(["POST /orders"]) });
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "POST", path: "/orders" }),
    }, postAllowed).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "POST", path: "/orders", body: { sku: "A-1", quantity: 2 } }),
    }, postAllowed).kind).toBe("action");
    // The method is part of the allowed-request identity: a GET grant never
    // authorizes a POST to the same path.
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "POST", path: "/orders" }),
    }, context({
      allowedApiRequests: new Set(["GET /orders"]),
      legacyPolicy: { apiMutationsEnabled: true, databaseDmlEnabled: true },
    })).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42", query: { full: true }, body: { nope: true } }),
    }, context())).toEqual({ kind: "invalid", feedback: "GET and HEAD requests do not take a body." });
  });

  it("gates approved mutations only for legacy frozen runs", () => {
    const apiAction = {
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: apiMutation.id, parameters: { id: "{{capture:orderId}}" } }),
    };
    const dbAction = {
      decision: "act",
      actionType: "db_execute_operation",
      argumentsJson: JSON.stringify({ operationId: dbMutation.id, parameters: { id: 42, status: "ready" } }),
    };

    // intent-v1 runs (no legacyPolicy) authorize mutations by configuring the layer.
    expect(validateMultiLayerDecision(apiAction, context()).kind).toBe("action");
    expect(validateMultiLayerDecision(dbAction, context()).kind).toBe("action");

    // Legacy frozen runs keep their original gates.
    const legacyDisabled = { legacyPolicy: { apiMutationsEnabled: false, databaseDmlEnabled: false } };
    expect(validateMultiLayerDecision(apiAction, context(legacyDisabled))).toEqual({
      kind: "invalid",
      feedback: "API mutations are disabled for this environment.",
    });
    expect(validateMultiLayerDecision(dbAction, context(legacyDisabled))).toEqual({
      kind: "invalid",
      feedback: "Database DML is disabled for this environment.",
    });

    const legacyEnabled = { legacyPolicy: { apiMutationsEnabled: true, databaseDmlEnabled: true } };
    expect(validateMultiLayerDecision(apiAction, context(legacyEnabled)).kind).toBe("action");
    expect(validateMultiLayerDecision(dbAction, context(legacyEnabled)).kind).toBe("action");
  });

  it("enforces hard single-layer hints and known placeholder names", () => {
    const apiRead = {
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42?full=true" }),
    };
    expect(validateMultiLayerDecision(apiRead, context({ layerHint: "ui" })).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_select",
      argumentsJson: JSON.stringify({ sql: "SELECT * FROM orders WHERE id=:id", parameters: { id: "{{capture:missing}}" } }),
    }, context()).kind).toBe("invalid");
  });

  it("accepts schema discovery and parameterized SELECT actions", () => {
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_schema",
      argumentsJson: JSON.stringify({ tablePattern: "orders" }),
    }, context()).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_select",
      argumentsJson: JSON.stringify({ sql: "SELECT status FROM orders WHERE id=:id", parameters: { id: "{{capture:orderId}}" } }),
    }, context()).kind).toBe("action");
  });

  it("accepts ad-hoc database mutations for intent-v1 runs only", () => {
    const mutate = {
      decision: "act",
      actionType: "db_mutate",
      argumentsJson: JSON.stringify({
        sql: "UPDATE orders SET status = :status WHERE id = :id",
        parameters: { id: 42, status: "ready" },
      }),
    };

    // intent-v1 runs (no legacyPolicy) authorize ad-hoc DML by configuring the db layer.
    expect(validateMultiLayerDecision(mutate, context())).toEqual({
      kind: "action",
      action: {
        layer: "db",
        type: "db_mutate",
        arguments: {
          sql: "UPDATE orders SET status = :status WHERE id = :id",
          parameters: { id: 42, status: "ready" },
          captures: [],
        },
      },
    });

    // Legacy-intent frozen runs never had an ad-hoc DML path at all.
    for (const databaseDmlEnabled of [false, true]) {
      expect(validateMultiLayerDecision(mutate, context({
        legacyPolicy: { apiMutationsEnabled: true, databaseDmlEnabled },
      }))).toEqual({
        kind: "invalid",
        feedback: expect.stringContaining("not enabled for this run"),
      });
    }
  });

  it("holds ad-hoc database mutations to the db layer policy and known placeholders", () => {
    const mutate = (sql: string, parameters: Record<string, unknown> = {}) => ({
      decision: "act",
      actionType: "db_mutate",
      argumentsJson: JSON.stringify({ sql, parameters }),
    });
    const statement = "UPDATE orders SET status = :status WHERE id = :id";

    expect(validateMultiLayerDecision(mutate(statement), context({
      configuredLayers: new Set(["ui", "api"]),
    })).kind).toBe("invalid");
    expect(validateMultiLayerDecision(mutate(statement), context({ layerHint: "ui" })).kind).toBe("invalid");
    expect(validateMultiLayerDecision(mutate(statement), context({ layerHint: "api" })).kind).toBe("invalid");

    // Same placeholder rule as db_select: only frozen secrets and captures
    // already taken in this case may appear anywhere in the statement.
    expect(validateMultiLayerDecision(
      mutate("UPDATE users SET token = '{{secret:UNKNOWN}}' WHERE id = :id", { id: 1 }),
      context(),
    ).kind).toBe("invalid");
    expect(validateMultiLayerDecision(
      mutate("DELETE FROM orders WHERE id = '{{capture:missing}}'"),
      context(),
    ).kind).toBe("invalid");
    expect(validateMultiLayerDecision(
      mutate("DELETE FROM orders WHERE id = '{{capture:orderId}}'"),
      context(),
    ).kind).toBe("action");
  });

  it("validates verdicts, blockers, snapshots, and malformed envelopes", () => {
    expect(validateMultiLayerDecision({ decision: "step_passed", actualResult: "Observed HTTP 200" }, context()))
      .toEqual({ kind: "step_passed", actualResult: "Observed HTTP 200" });
    expect(validateMultiLayerDecision({ decision: "step_failed", actualResult: "  " }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({ decision: "blocked", reason: "No fixture" }, context()))
      .toEqual({ kind: "blocked", reason: "No fixture" });
    expect(validateMultiLayerDecision({ decision: "act", actionType: "ui_snapshot" }, context()).kind).toBe("action");
    expect(validateMultiLayerDecision({ decision: "act" }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({ decision: "act", actionType: "db_schema", argumentsJson: "not-json" }, context()).kind)
      .toBe("invalid");
    expect(validateMultiLayerDecision({ decision: "act", actionType: "unknown", argumentsJson: "{}" }, context()).kind)
      .toBe("invalid");
    expect(validateMultiLayerDecision({ decision: "unknown" }, context()).kind).toBe("invalid");
  });

  it("rejects malformed paths, bad operation identities, and incompatible drivers", () => {
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "http://[" }),
    }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42?full=true", query: { ignored: null } }),
    }, context({
      allowedApiRequests: new Set(["GET http://["]),
      legacyPolicy: { apiMutationsEnabled: false, databaseDmlEnabled: false },
    })).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: "missing" }),
    }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_execute_operation",
      argumentsJson: JSON.stringify({ operationId: dbMutation.id }),
    }, context({ databaseDriver: "mysql" })).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_schema",
      argumentsJson: JSON.stringify({ tablePattern: "x" }),
    }, context({ configuredLayers: new Set(["ui", "api"]) })).kind).toBe("invalid");
  });

  it("validates pinned capability parameter schemas without exposing values", () => {
    const capability: IntegrationCapability = {
      ...apiMutation,
      parameterSchema: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
        additionalProperties: false,
      },
    };
    expect(validateCapabilityParameterSchema(capability.parameterSchema)).toBeNull();
    expect(validateCapabilityParameters(capability, { id: 42 })).toBeNull();
    expect(validateCapabilityParameters(capability, { id: "secret-value" }))
      .toContain("parameters do not match the approved schema");

    const malformed = { ...capability, parameterSchema: { type: 42 } };
    expect(validateCapabilityParameterSchema(malformed.parameterSchema)).toContain("not a valid JSON Schema");
    expect(validateCapabilityParameters(malformed, {})).toContain("invalid pinned parameter schema");
  });

  it("enforces contract request-body rules for operations", () => {
    const bodyRequired: IntegrationCapability = {
      ...apiMutation,
      id: "api-create-order-v2",
      name: "createOrderV2",
      requestBodySchema: { type: "object" },
      requestBodyRequired: true,
    };
    const bodyOptional: IntegrationCapability = {
      ...apiMutation,
      id: "api-patch-order-v2",
      name: "patchOrderV2",
      requestBodySchema: { type: "object" },
      requestBodyRequired: false,
    };
    const bodyContext = context({
      capabilities: new Map([
        [apiMutation.id, apiMutation],
        [dbMutation.id, dbMutation],
        [bodyRequired.id, bodyRequired],
        [bodyOptional.id, bodyOptional],
      ]),
    });

    // A body for an API operation whose contract declares none.
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: apiMutation.id, body: { any: 1 } }),
    }, bodyContext)).toEqual({
      kind: "invalid",
      feedback: 'Operation "createOrder" does not take a request body.',
    });
    // Database operations never take request bodies.
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_execute_operation",
      argumentsJson: JSON.stringify({ operationId: dbMutation.id, parameters: { id: 42, status: "ready" }, body: { any: 1 } }),
    }, bodyContext)).toEqual({
      kind: "invalid",
      feedback: 'Operation "markOrder" does not take a request body.',
    });
    // A required contract body must be supplied.
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: bodyRequired.id }),
    }, bodyContext)).toEqual({
      kind: "invalid",
      feedback: 'Operation "createOrderV2" requires a JSON request body.',
    });
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: bodyRequired.id, body: { sku: "A-1" } }),
    }, bodyContext).kind).toBe("action");
    // An optional contract body may be omitted or supplied.
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: bodyOptional.id }),
    }, bodyContext).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: bodyOptional.id, body: { status: "ready" } }),
    }, bodyContext).kind).toBe("action");
  });

  it("validates operation request bodies against the pinned contract schema", () => {
    const capability: IntegrationCapability = {
      ...apiMutation,
      requestBodySchema: {
        type: "object",
        properties: { quantity: { type: "integer" } },
        required: ["quantity"],
        additionalProperties: false,
      },
      requestBodyRequired: true,
    };
    expect(validateCapabilityRequestBody(capability, { quantity: 3 })).toBeNull();
    expect(validateCapabilityRequestBody(capability, { quantity: "three" }))
      .toContain("request body does not match");
  });

  it("describes every durable action without including argument values", () => {
    const actions: MultiLayerAction[] = [
      { layer: "ui", type: "ui_snapshot" },
      {
        layer: "ui",
        type: "ui_action",
        action: { type: "click", ref: "e1", elementDescription: "Save" },
      },
      {
        layer: "api",
        type: "api_request",
        arguments: { method: "GET", path: "/orders", query: {}, headers: {}, captures: [] },
      },
      {
        layer: "api",
        type: "api_execute_operation",
        capability: apiMutation,
        arguments: { operationId: apiMutation.id, parameters: {}, captures: [] },
      },
      { layer: "db", type: "db_schema", arguments: {} },
      { layer: "db", type: "db_schema", arguments: { tablePattern: "orders" } },
      {
        layer: "db",
        type: "db_select",
        arguments: { sql: "SELECT 1", parameters: {}, captures: [] },
      },
      {
        layer: "db",
        type: "db_mutate",
        arguments: { sql: "DELETE FROM orders WHERE id = :id", parameters: { id: 1 }, captures: [] },
      },
      {
        layer: "db",
        type: "db_execute_operation",
        capability: dbMutation,
        arguments: { operationId: dbMutation.id, parameters: {}, captures: [] },
      },
    ];

    expect(actions.map(describeMultiLayerAction)).toEqual([
      "Inspect the current UI",
      "click UI action",
      "GET /orders",
      "API operation createOrder",
      "Inspect database schema",
      "Inspect database schema for orders",
      "Execute parameterized database SELECT",
      "Execute parameterized database mutation",
      "Database operation markOrder",
    ]);
  });

  it("rejects unknown nested placeholders and non-object arguments", () => {
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({
        method: "GET",
        path: "/orders/42?full=true",
        query: { token: "{{secret:UNKNOWN}}" },
      }),
    }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_schema",
      argumentsJson: "[]",
    }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_select",
      argumentsJson: JSON.stringify({ sql: "SELECT 1" }),
    }, context({ layerHint: "api" })).kind).toBe("invalid");
  });

  it("lets the agent choose a form encoding for documented request parameters", () => {
    // An API documenting "Request Parameters" reads form fields; sending JSON
    // makes the server report every parameter as missing.
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({
        method: "POST",
        path: "/createAccount",
        body: { name: "Jane" },
        contentType: "application/x-www-form-urlencoded",
      }),
    }, context({ allowedApiRequests: new Set(["POST /createAccount"]) }));

    expect(result).toMatchObject({
      kind: "action",
      action: { type: "api_request", arguments: { contentType: "application/x-www-form-urlencoded" } },
    });
  });

  it("rejects an unsupported body encoding", () => {
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({
        method: "POST", path: "/createAccount", body: { a: 1 }, contentType: "multipart/form-data",
      }),
    }, context({ allowedApiRequests: new Set(["POST /createAccount"]) }));

    expect(result).toMatchObject({ kind: "invalid" });
  });

  it("lets an intent-v1 run call an endpoint the step only described", () => {
    // "get booking ids" against a booking API means GET /booking. Approval
    // authorizes the work the step needs; the wire still confines it to the
    // configured origin and base path.
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/booking" }),
    }, context({ allowedApiRequests: new Set() }));

    expect(result).toMatchObject({ kind: "action", action: { type: "api_request" } });
  });

  it("keeps a legacy frozen run to the endpoints it was approved with", () => {
    const legacy = context({
      allowedApiRequests: new Set(["GET /orders"]),
      legacyPolicy: { apiMutationsEnabled: true, databaseDmlEnabled: true },
    });

    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/orders" }),
    }, legacy).kind).toBe("action");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/booking" }),
    }, legacy)).toMatchObject({
      kind: "invalid",
      feedback: expect.stringContaining("only call API operations named in its frozen steps"),
    });
  });

  it("names the usable action types when the model invents one", () => {
    // A near-miss like "http_request" is one correction away, but only if the
    // feedback says the real names — otherwise the model concludes the layer
    // is unavailable and reports the step blocked.
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "http_request",
      argumentsJson: JSON.stringify({ method: "POST", path: "/booking" }),
    }, context());

    expect(result).toMatchObject({ kind: "invalid" });
    const feedback = (result as { feedback: string }).feedback;
    expect(feedback).toContain("api_request");
    expect(feedback).toContain("db_select");
    expect(feedback).toContain("ui_snapshot");
  });

  it("accepts Content-Type and folds it into the body encoding", () => {
    // The executor derives Content-Type from the encoding and would overwrite
    // the header, so a header-only declaration must not silently send JSON.
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({
        method: "POST", path: "/booking", body: { name: "Jane" },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    }, context());

    expect(result).toMatchObject({
      kind: "action",
      action: { arguments: { contentType: "application/x-www-form-urlencoded", headers: {} } },
    });
  });

  it("keeps an explicit contentType over a conflicting header", () => {
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({
        method: "POST", path: "/booking", body: { a: 1 },
        contentType: "application/json",
        headers: { "content-type": "text/plain" },
      }),
    }, context());

    expect(result).toMatchObject({ action: { arguments: { contentType: "application/json" } } });
  });

  it("allows an API-specific header but still blocks environment-owned ones", () => {
    const withHeader = (headers: Record<string, string>) => validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/booking", headers }),
    }, context());

    expect(withHeader({ "X-API-Version": "2" }).kind).toBe("action");
    expect(withHeader({ Accept: "application/json" }).kind).toBe("action");
    for (const blocked of ["Authorization", "Cookie", "Host", "X-HTTP-Method-Override"]) {
      expect(withHeader({ [blocked]: "x" })).toMatchObject({ kind: "invalid" });
    }
  });

  it("rejects an unsupported content type with the supported list", () => {
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({
        method: "POST", path: "/booking", body: { a: 1 },
        headers: { "Content-Type": "multipart/form-data" },
      }),
    }, context());

    expect(result).toMatchObject({
      kind: "invalid",
      feedback: expect.stringContaining("application/x-www-form-urlencoded"),
    });
  });

  it("shows the expected argument shape when the request will not parse", () => {
    const result = validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "POST", url: "/booking" }),
    }, context());

    expect(result).toMatchObject({
      kind: "invalid",
      feedback: expect.stringContaining("path is relative to the base URL"),
    });
  });
});
