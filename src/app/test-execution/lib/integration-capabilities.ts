export type IntegrationOperationView = {
  id: string;
  stableKey: string;
  displayName: string;
  revision: number;
  layer: "api" | "db";
  sourceKind: "manual" | "openapi";
  safetyClass: "read" | "mutation";
  databaseDriver: "postgres" | "sqlserver" | "mysql" | null;
  apiContractRevisionId: string | null;
  parameterSchema: Record<string, unknown>;
  definition: Record<string, unknown>;
  approvalStatus: "draft" | "approved" | "archived";
  approvedAt: string | null;
  createdAt: string;
};

export type CapabilityEnvironment = {
  targets: readonly ("UI" | "API" | "DB")[];
  databaseDriver: "postgres" | "sqlserver" | "mysql" | null;
  apiMutationsEnabled: boolean;
  databaseDmlEnabled: boolean;
};

export type CapabilitySafetyClass = IntegrationOperationView["safetyClass"];

/**
 * Safe, executable starter shapes for the manual capability editor. Connection
 * details and credentials deliberately never appear here: those remain owned
 * by the environment and its write-only secret fields.
 */
export function capabilityEditorTemplate(
  layer: IntegrationOperationView["layer"],
  safetyClass: CapabilitySafetyClass,
): { parameterSchema: Record<string, unknown>; definition: Record<string, unknown> } {
  if (layer === "api" && safetyClass === "read") {
    return {
      parameterSchema: objectSchema({ orderId: { type: "string" } }, ["orderId"]),
      definition: { method: "GET", path: "/orders/{orderId}" },
    };
  }
  if (layer === "api") {
    return {
      parameterSchema: objectSchema({ customerId: { type: "string" } }, ["customerId"]),
      definition: {
        method: "POST",
        path: "/orders",
        body: { customerId: "{{param:customerId}}" },
        contentType: "application/json",
      },
    };
  }
  if (safetyClass === "read") {
    return {
      parameterSchema: objectSchema({ orderId: { type: "string" } }, ["orderId"]),
      definition: { sql: "SELECT id, status FROM public.orders WHERE id = :orderId" },
    };
  }
  return {
    parameterSchema: objectSchema(
      { orderId: { type: "string" }, status: { type: "string" } },
      ["orderId", "status"],
    ),
    definition: { sql: "UPDATE public.orders SET status = :status WHERE id = :orderId" },
  };
}

export function capabilityDefinitionSummary(operation: IntegrationOperationView): string {
  if (operation.layer === "api") {
    const method = text(operation.definition.method).toUpperCase();
    const path = text(operation.definition.path);
    return [method, path].filter(Boolean).join(" ") || "API operation";
  }
  const sql = text(operation.definition.sql).replace(/\s+/g, " ").trim();
  return sql ? (sql.length > 120 ? `${sql.slice(0, 117)}...` : sql) : "Database operation";
}

/** Read models are camelCase, but tolerate database-style keys during rolling upgrades. */
export function normalizeIntegrationOperation(value: unknown): IntegrationOperationView | null {
  const row = record(value);
  if (!row) return null;
  const layer = text(row.layer);
  const sourceKind = text(row.sourceKind ?? row.source_kind);
  const safetyClass = text(row.safetyClass ?? row.safety_class);
  const approvalStatus = text(row.approvalStatus ?? row.approval_status);
  const databaseDriver = nullableText(row.databaseDriver ?? row.database_driver);
  if (
    !text(row.id) ||
    !["api", "db"].includes(layer) ||
    !["manual", "openapi"].includes(sourceKind) ||
    !["read", "mutation"].includes(safetyClass) ||
    !["draft", "approved", "archived"].includes(approvalStatus) ||
    (databaseDriver !== null && !["postgres", "sqlserver", "mysql"].includes(databaseDriver))
  ) return null;
  return {
    id: text(row.id),
    stableKey: text(row.stableKey ?? row.stable_key),
    displayName: text(row.displayName ?? row.display_name),
    revision: number(row.revision),
    layer: layer as IntegrationOperationView["layer"],
    sourceKind: sourceKind as IntegrationOperationView["sourceKind"],
    safetyClass: safetyClass as IntegrationOperationView["safetyClass"],
    databaseDriver: databaseDriver as IntegrationOperationView["databaseDriver"],
    apiContractRevisionId: nullableText(row.apiContractRevisionId ?? row.api_contract_revision_id),
    parameterSchema: record(row.parameterSchema ?? row.parameter_schema_json) ?? {},
    definition: record(row.definition ?? row.definition_json) ?? {},
    approvalStatus: approvalStatus as IntegrationOperationView["approvalStatus"],
    approvedAt: nullableText(row.approvedAt ?? row.approved_at),
    createdAt: text(row.createdAt ?? row.created_at),
  };
}

export function capabilityCompatibilityIssue(
  operation: IntegrationOperationView,
  environment: CapabilityEnvironment,
): string | null {
  if (operation.layer === "api" && !environment.targets.includes("API")) return "Configure an API target first.";
  if (operation.layer === "db" && !environment.targets.includes("DB")) return "Configure a database target first.";
  if (operation.layer === "db" && operation.databaseDriver && operation.databaseDriver !== environment.databaseDriver) {
    return `Requires ${databaseDriverLabel(operation.databaseDriver)}.`;
  }
  if (operation.safetyClass === "mutation" && operation.layer === "api" && !environment.apiMutationsEnabled) {
    return "Enable approved API catalog mutations in the environment.";
  }
  if (operation.safetyClass === "mutation" && operation.layer === "db" && !environment.databaseDmlEnabled) {
    return "Enable approved database DML in the environment.";
  }
  return null;
}

export function compatibleApprovedCapabilityIds(
  operations: readonly IntegrationOperationView[],
  environment: CapabilityEnvironment,
): string[] {
  const latest = new Map<string, IntegrationOperationView>();
  for (const operation of operations) {
    if (operation.approvalStatus !== "approved") continue;
    const current = latest.get(operation.stableKey);
    if (!current || operation.revision > current.revision) latest.set(operation.stableKey, operation);
  }
  return [...latest.values()]
    .filter((operation) => !capabilityCompatibilityIssue(operation, environment))
    .map((operation) => operation.id);
}

export function parseJsonObject(
  value: string,
  label: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!record(parsed)) return { ok: false, error: `${label} must be a JSON object.` };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: `${label} is not valid JSON.` };
  }
}

export function databaseDriverLabel(driver: NonNullable<IntegrationOperationView["databaseDriver"]>): string {
  return driver === "postgres" ? "PostgreSQL" : driver === "sqlserver" ? "SQL Server" : "MySQL";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const result = text(value);
  return result || null;
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
