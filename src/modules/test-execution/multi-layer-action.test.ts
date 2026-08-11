import { describe, expect, it } from "vitest";

import {
  describeMultiLayerAction,
  validateCapabilityParameterSchema,
  validateCapabilityParameters,
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
    allowedApiReadPaths: new Set(["/orders/42?full=true"]),
    secretNames: ["USER_PASSWORD"],
    captureNames: ["orderId"],
    capabilities: new Map([[apiMutation.id, apiMutation], [dbMutation.id, dbMutation]]),
    apiMutationsEnabled: false,
    databaseDmlEnabled: false,
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

  it("allows only exact frozen GET/HEAD paths for dynamic API reads", () => {
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
    }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_request",
      argumentsJson: JSON.stringify({ method: "GET", path: "/admin" }),
    }, context()).kind).toBe("invalid");
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

  it("double-gates approved mutations with the environment access mode", () => {
    const apiAction = {
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: apiMutation.id, parameters: { id: "{{capture:orderId}}" } }),
    };
    expect(validateMultiLayerDecision(apiAction, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision(apiAction, context({ apiMutationsEnabled: true })).kind).toBe("action");

    const dbAction = {
      decision: "act",
      actionType: "db_execute_operation",
      argumentsJson: JSON.stringify({ operationId: dbMutation.id, parameters: { id: 42, status: "ready" } }),
    };
    expect(validateMultiLayerDecision(dbAction, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision(dbAction, context({ databaseDmlEnabled: true })).kind).toBe("action");
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
    }, context({ allowedApiReadPaths: new Set(["http://["]) })).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "api_execute_operation",
      argumentsJson: JSON.stringify({ operationId: "missing" }),
    }, context()).kind).toBe("invalid");
    expect(validateMultiLayerDecision({
      decision: "act",
      actionType: "db_execute_operation",
      argumentsJson: JSON.stringify({ operationId: dbMutation.id }),
    }, context({ databaseDmlEnabled: true, databaseDriver: "mysql" })).kind).toBe("invalid");
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
});
