import { describe, expect, it } from "vitest";

import {
  capabilityDefinitionSummary,
  capabilityEditorTemplate,
  capabilityCompatibilityIssue,
  compatibleApprovedCapabilityIds,
  normalizeIntegrationOperation,
  parseJsonObject,
  type IntegrationOperationView,
} from "./integration-capabilities";

const operation: IntegrationOperationView = {
  id: "op_1",
  stableKey: "orders.create",
  displayName: "Create order",
  revision: 1,
  layer: "api",
  sourceKind: "manual",
  safetyClass: "mutation",
  databaseDriver: null,
  apiContractRevisionId: null,
  parameterSchema: {},
  definition: { method: "POST", path: "/orders" },
  approvalStatus: "approved",
  approvedAt: "2026-08-10T00:00:00.000Z",
  createdAt: "2026-08-10T00:00:00.000Z",
};

describe("integration capability helpers", () => {
  it("normalizes camelCase and database-style route rows", () => {
    expect(normalizeIntegrationOperation(operation)).toMatchObject({ id: "op_1", approvalStatus: "approved" });
    expect(normalizeIntegrationOperation({
      id: "op_2",
      stable_key: "orders.lookup",
      display_name: "Lookup order",
      revision: 2,
      layer: "db",
      source_kind: "manual",
      safety_class: "read",
      database_driver: "postgres",
      approval_status: "draft",
      parameter_schema_json: {},
      definition_json: { sql: "SELECT 1" },
    })).toMatchObject({ stableKey: "orders.lookup", databaseDriver: "postgres" });
  });

  it("filters approved operations by configured layer, driver, and mutation opt-in", () => {
    const environment = { targets: ["API"] as const, databaseDriver: null, apiMutationsEnabled: false, databaseDmlEnabled: false };
    expect(capabilityCompatibilityIssue(operation, environment)).toMatch(/mutations/i);
    expect(compatibleApprovedCapabilityIds([operation], environment)).toEqual([]);
    expect(compatibleApprovedCapabilityIds([operation], { ...environment, apiMutationsEnabled: true })).toEqual(["op_1"]);
    expect(compatibleApprovedCapabilityIds([
      operation,
      { ...operation, id: "op_2", revision: 2 },
    ], { ...environment, apiMutationsEnabled: true })).toEqual(["op_2"]);
  });

  it("parses object-only JSON editor fields", () => {
    expect(parseJsonObject('{"type":"object"}', "Parameters")).toEqual({ ok: true, value: { type: "object" } });
    expect(parseJsonObject("[]", "Parameters")).toEqual({ ok: false, error: "Parameters must be a JSON object." });
    expect(parseJsonObject("{", "Definition")).toEqual({ ok: false, error: "Definition is not valid JSON." });
  });

  it("provides safe parameterized API and database editor templates", () => {
    expect(capabilityEditorTemplate("api", "mutation")).toMatchObject({
      definition: {
        method: "POST",
        path: "/orders",
        body: { customerId: "{{param:customerId}}" },
      },
    });
    expect(capabilityEditorTemplate("db", "read")).toMatchObject({
      definition: { sql: expect.stringContaining(":orderId") },
      parameterSchema: { additionalProperties: false },
    });
  });

  it("creates compact, non-secret operation summaries", () => {
    expect(capabilityDefinitionSummary(operation)).toBe("POST /orders");
    expect(capabilityDefinitionSummary({
      ...operation,
      layer: "db",
      databaseDriver: "postgres",
      definition: { sql: "SELECT id\nFROM public.orders" },
    })).toBe("SELECT id FROM public.orders");
  });
});
