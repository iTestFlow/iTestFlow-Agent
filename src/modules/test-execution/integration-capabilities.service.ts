import "server-only";

import type { PoolClient } from "pg";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  createId,
  nowIso,
  sqlAll,
  sqlGet,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";
import { isForbiddenRequestHeader, isSensitiveKey } from "@/modules/shared/sensitive-data";
import { validateSqlTemplate } from "@/modules/integrations/database-automation/sql-policy";
import { IntegrationOperationRevisionInputSchema } from "./schemas/test-execution.schemas";
import { validateCapabilityParameterSchema } from "./multi-layer-action";

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

export type IntegrationOperationDraft = Omit<
  IntegrationOperationView,
  "id" | "revision" | "approvalStatus" | "approvedAt" | "createdAt"
>;

export type IntegrationOperationChanges = Partial<Pick<
  IntegrationOperationDraft,
  | "displayName"
  | "sourceKind"
  | "safetyClass"
  | "databaseDriver"
  | "apiContractRevisionId"
  | "parameterSchema"
  | "definition"
>>;

type OperationRow = {
  id: string;
  stable_key: string;
  display_name: string;
  revision: number;
  layer: "api" | "db";
  source_kind: "manual" | "openapi";
  safety_class: "read" | "mutation";
  database_driver: "postgres" | "sqlserver" | "mysql" | null;
  api_contract_revision_id: string | null;
  parameter_schema_json: Record<string, unknown>;
  definition_json: Record<string, unknown>;
  approval_status: "draft" | "approved" | "archived";
  approved_at: string | null;
  created_at: string;
};

export class IntegrationOperationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "IntegrationOperationError";
  }
}

function scopeParams(workspaceId: string, scope: ProjectScope) {
  return {
    workspaceId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  };
}

function toView(row: OperationRow): IntegrationOperationView {
  return {
    id: row.id,
    stableKey: row.stable_key,
    displayName: row.display_name,
    revision: row.revision,
    layer: row.layer,
    sourceKind: row.source_kind,
    safetyClass: row.safety_class,
    databaseDriver: row.database_driver,
    apiContractRevisionId: row.api_contract_revision_id,
    parameterSchema: row.parameter_schema_json,
    definition: row.definition_json,
    approvalStatus: row.approval_status,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

const OPERATION_COLUMNS = `id, stable_key, display_name, revision, layer, source_kind,
  safety_class, database_driver, api_contract_revision_id, parameter_schema_json,
  definition_json, approval_status, approved_at, created_at`;

/** Latest revision per logical operation. Members receive approved capabilities only. */
export async function listIntegrationOperations(input: {
  workspaceId: string;
  scope: ProjectScope;
  includeAll?: boolean;
}): Promise<IntegrationOperationView[]> {
  const rows = await sqlAll<OperationRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (stable_key) ${OPERATION_COLUMNS}
       FROM test_integration_operation_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId
       ORDER BY stable_key, revision DESC
     ), latest_approved AS (
       SELECT DISTINCT ON (stable_key) ${OPERATION_COLUMNS}
       FROM test_integration_operation_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId AND approval_status = 'approved'
       ORDER BY stable_key, revision DESC
     ), latest_archive AS (
       SELECT stable_key, MAX(revision) AS revision
       FROM test_integration_operation_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId AND approval_status = 'archived'
       GROUP BY stable_key
     ), visible AS (
       SELECT * FROM latest WHERE @includeAll = true
       UNION ALL
       SELECT approved.* FROM latest_approved approved
       LEFT JOIN latest_archive archived USING (stable_key)
       WHERE @includeAll = false AND approved.revision > COALESCE(archived.revision, 0)
     )
     SELECT ${OPERATION_COLUMNS} FROM visible
     ORDER BY layer, stable_key`,
    { ...scopeParams(input.workspaceId, input.scope), includeAll: input.includeAll === true },
  );
  return rows.map(toView);
}

export async function createIntegrationOperation(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  operation: IntegrationOperationDraft;
}): Promise<IntegrationOperationView> {
  const operation = validateOperation({ ...input.operation, revision: 1, approvalStatus: "draft" });
  const created = await withTransaction(async (client) => {
    await lockOperationIdentity(client, input.workspaceId, input.scope, operation.stableKey);
    const existing = await sqlGet<{ id: string }>(
      `SELECT id FROM test_integration_operation_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId AND stable_key = @stableKey
       LIMIT 1`,
      { ...scopeParams(input.workspaceId, input.scope), stableKey: operation.stableKey },
      client,
    );
    if (existing) {
      throw new IntegrationOperationError(
        "An integration operation with this key already exists. Revise its latest version instead.",
        409,
      );
    }
    return insertOperationRevision(client, {
      workspaceId: input.workspaceId,
      scope: input.scope,
      actor: input.actor,
      operation,
      revision: 1,
      approvalStatus: "draft",
    });
  });
  auditOperation(input, created, "test_execution.integration_operation_created");
  return created;
}

export async function transitionIntegrationOperation(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  operationRevisionId: string;
  action: "revise" | "approve" | "archive";
  changes?: IntegrationOperationChanges;
}): Promise<IntegrationOperationView | null> {
  const result = await withTransaction(async (client) => {
    const base = await loadOperationRow(client, input.workspaceId, input.scope, input.operationRevisionId);
    if (!base) return null;
    await lockOperationIdentity(client, input.workspaceId, input.scope, base.stable_key);
    const latest = await sqlGet<{ revision: number }>(
      `SELECT revision FROM test_integration_operation_revisions
       WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId AND stable_key = @stableKey
       ORDER BY revision DESC LIMIT 1`,
      { ...scopeParams(input.workspaceId, input.scope), stableKey: base.stable_key },
      client,
    );
    if (!latest || latest.revision !== base.revision) {
      throw new IntegrationOperationError(
        "This operation revision is stale. Refresh and update the latest revision.",
        409,
      );
    }
    if (input.action === "approve" && base.approval_status !== "draft") {
      throw new IntegrationOperationError("Only a draft operation can be approved.", 409);
    }
    if (input.action === "archive" && base.approval_status === "archived") {
      throw new IntegrationOperationError("The operation is already archived.", 409);
    }
    if (input.action !== "revise" && input.changes && Object.keys(input.changes).length > 0) {
      throw new IntegrationOperationError("Changes are accepted only when creating a draft revision.");
    }

    const baseView = toView(base);
    const operation = validateOperation({
      stableKey: baseView.stableKey,
      displayName: input.changes?.displayName ?? baseView.displayName,
      layer: baseView.layer,
      sourceKind: input.changes?.sourceKind ?? baseView.sourceKind,
      safetyClass: input.changes?.safetyClass ?? baseView.safetyClass,
      databaseDriver: input.changes?.databaseDriver ?? baseView.databaseDriver,
      apiContractRevisionId:
        input.changes?.apiContractRevisionId === undefined
          ? baseView.apiContractRevisionId
          : input.changes.apiContractRevisionId,
      parameterSchema: input.changes?.parameterSchema ?? baseView.parameterSchema,
      definition: input.changes?.definition ?? baseView.definition,
      revision: baseView.revision + 1,
      approvalStatus: input.action === "approve" ? "approved" : input.action === "archive" ? "archived" : "draft",
    });
    return insertOperationRevision(client, {
      workspaceId: input.workspaceId,
      scope: input.scope,
      actor: input.actor,
      operation,
      revision: baseView.revision + 1,
      approvalStatus: operation.approvalStatus,
    });
  });
  if (result) auditOperation(input, result, `test_execution.integration_operation_${input.action}d`);
  return result;
}

function validateOperation(input: {
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
}) {
  const parsed = IntegrationOperationRevisionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new IntegrationOperationError(parsed.error.issues[0]?.message ?? "Invalid integration operation.");
  }
  const schemaIssue = validateCapabilityParameterSchema(parsed.data.parameterSchema);
  if (schemaIssue) throw new IntegrationOperationError(schemaIssue);
  validateDefinition(
    parsed.data.layer,
    parsed.data.safetyClass,
    parsed.data.definition,
    parsed.data.parameterSchema,
    parsed.data.databaseDriver,
  );
  return parsed.data;
}

function validateDefinition(
  layer: "api" | "db",
  safetyClass: "read" | "mutation",
  definition: Record<string, unknown>,
  parameterSchema: Record<string, unknown>,
  databaseDriver: "postgres" | "sqlserver" | "mysql" | null,
): void {
  const declaredParameters = schemaPropertyNames(parameterSchema);
  if (layer === "api") {
    const method = typeof definition.method === "string" ? definition.method.toUpperCase() : "";
    const path = typeof definition.path === "string" ? definition.path.trim() : "";
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new IntegrationOperationError("API operations require an allowed HTTP method.");
    }
    if (!isSafeApiOperationPath(path)) {
      throw new IntegrationOperationError("API operation paths must be safe relative paths.");
    }
    if (path.includes("{{param:")) {
      throw new IntegrationOperationError("API path parameters use {name}; use {{param:name}} only in headers, query, or body values.");
    }
    const headers = recordValue(definition.headers);
    const forbiddenHeader = Object.keys(headers).find(isForbiddenOperationHeader);
    if (forbiddenHeader) {
      throw new IntegrationOperationError(`API operation header "${forbiddenHeader}" is environment-owned or unsafe.`);
    }
    if (findLiteralCredential(definition)) {
      throw new IntegrationOperationError("API operation definitions cannot store literal credentials; keep authentication in the environment target.");
    }
    const isRead = method === "GET" || method === "HEAD";
    if ((safetyClass === "read") !== isRead) {
      throw new IntegrationOperationError("The API method does not match the selected safety class.");
    }
    validateTemplateParameters(
      new Set([
        ...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g),
      ].map((match) => match[1]).concat(templateParameterNames(definition))),
      declaredParameters,
    );
    return;
  }

  const sql = typeof definition.sql === "string" ? definition.sql.trim() : "";
  if (!sql) throw new IntegrationOperationError("Database operations require a SQL template.");
  if (!databaseDriver) throw new IntegrationOperationError("Database operations require a driver.");
  // Authoring runs the SAME validator as runtime (minus the environment's
  // schema allowlist and bind values), so an operation that saves can
  // actually execute instead of becoming a dead capability.
  try {
    validateSqlTemplate({
      sql,
      intent: safetyClass === "read" ? "select" : "mutation",
      driver: databaseDriver,
      declaredParameters,
    });
  } catch (error) {
    throw new IntegrationOperationError(error instanceof Error ? error.message : "The SQL template failed validation.");
  }
}

function isSafeApiOperationPath(path: string): boolean {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("://") ||
    /[\s\\?#]/.test(path)
  ) return false;
  try {
    const decoded = decodeURIComponent(path);
    return !decoded.split("/").some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function schemaPropertyNames(schema: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(recordValue(schema.properties)));
}

function templateParameterNames(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/\{\{param:([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((match) => match[1]);
  }
  if (Array.isArray(value)) return value.flatMap(templateParameterNames);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(templateParameterNames);
  return [];
}

function validateTemplateParameters(used: ReadonlySet<string>, declared: ReadonlySet<string>): void {
  const undeclared = [...used].find((name) => !declared.has(name));
  if (undeclared) throw new IntegrationOperationError(`Template parameter "${undeclared}" is missing from the parameter schema.`);
  const unused = [...declared].find((name) => !used.has(name));
  if (unused) throw new IntegrationOperationError(`Parameter schema property "${unused}" is not used by the operation template.`);
}

function isForbiddenOperationHeader(name: string): boolean {
  return isForbiddenRequestHeader(name);
}

function findLiteralCredential(value: unknown, key = ""): boolean {
  if (Array.isArray(value)) return value.some((entry) => findLiteralCredential(entry, key));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, entry]) => findLiteralCredential(entry, childKey));
  }
  if (!isSensitiveKey(key)) return false;
  return typeof value === "string" && value.length > 0 && !/^\{\{param:[A-Za-z_][A-Za-z0-9_]*\}\}$/.test(value);
}

async function lockOperationIdentity(
  client: PoolClient,
  workspaceId: string,
  scope: ProjectScope,
  stableKey: string,
): Promise<void> {
  await sqlGet(
    `SELECT pg_advisory_xact_lock(hashtext(@lockKey))`,
    { lockKey: `${workspaceId}:${scope.projectId}:${scope.azureProjectId}:${stableKey}` },
    client,
  );
}

async function loadOperationRow(
  client: PoolClient,
  workspaceId: string,
  scope: ProjectScope,
  operationRevisionId: string,
): Promise<OperationRow | undefined> {
  return sqlGet<OperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM test_integration_operation_revisions
     WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId
       AND azure_project_id = @azureProjectId`,
    { id: operationRevisionId, ...scopeParams(workspaceId, scope) },
    client,
  );
}

async function insertOperationRevision(
  client: PoolClient,
  input: {
    workspaceId: string;
    scope: ProjectScope;
    actor: string;
    operation: ReturnType<typeof validateOperation>;
    revision: number;
    approvalStatus: "draft" | "approved" | "archived";
  },
): Promise<IntegrationOperationView> {
  if (input.operation.apiContractRevisionId) {
    const contract = await sqlGet<{ id: string }>(
      `SELECT id FROM test_api_contract_revisions
       WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId
         AND azure_project_id = @azureProjectId`,
      {
        id: input.operation.apiContractRevisionId,
        ...scopeParams(input.workspaceId, input.scope),
      },
      client,
    );
    if (!contract) {
      throw new IntegrationOperationError("The selected API contract revision was not found.", 422);
    }
  }
  const id = createId("tiop");
  const now = nowIso();
  const row = await sqlGet<OperationRow>(
    `INSERT INTO test_integration_operation_revisions (
       id, workspace_id, project_id, azure_project_id, stable_key, display_name,
       revision, layer, source_kind, safety_class, database_driver,
       api_contract_revision_id, parameter_schema_json, definition_json,
       approval_status, approved_by, approved_at, created_by, created_at
     ) VALUES (
       @id, @workspaceId, @projectId, @azureProjectId, @stableKey, @displayName,
       @revision, @layer, @sourceKind, @safetyClass, @databaseDriver,
       @apiContractRevisionId, @parameterSchemaJson::jsonb, @definitionJson::jsonb,
       @approvalStatus, @approvedBy, @approvedAt, @actor, @now
     )
     RETURNING ${OPERATION_COLUMNS}`,
    {
      id,
      ...scopeParams(input.workspaceId, input.scope),
      stableKey: input.operation.stableKey,
      displayName: input.operation.displayName,
      revision: input.revision,
      layer: input.operation.layer,
      sourceKind: input.operation.sourceKind,
      safetyClass: input.operation.safetyClass,
      databaseDriver: input.operation.databaseDriver,
      apiContractRevisionId: input.operation.apiContractRevisionId,
      parameterSchemaJson: JSON.stringify(input.operation.parameterSchema),
      definitionJson: JSON.stringify(input.operation.definition),
      approvalStatus: input.approvalStatus,
      approvedBy: input.approvalStatus === "approved" ? input.actor : null,
      approvedAt: input.approvalStatus === "approved" ? now : null,
      actor: input.actor,
      now,
    },
    client,
  );
  if (!row) throw new IntegrationOperationError("The integration operation could not be saved.", 500);
  return toView(row);
}

function auditOperation(
  input: { workspaceId: string; scope: ProjectScope; actor: string },
  operation: IntegrationOperationView,
  action: string,
): void {
  writeAuditLog({
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    azureProjectName: input.scope.azureProjectName,
    azureOrganizationUrl: input.scope.azureOrganizationUrl,
    entityType: "test_integration_operation_revision",
    entityId: operation.id,
    action,
    status: "Success",
    actor: input.actor,
    message: `Integration operation ${operation.stableKey} revision ${operation.revision} is ${operation.approvalStatus}.`,
    details: { layer: operation.layer, safetyClass: operation.safetyClass },
  });
}
