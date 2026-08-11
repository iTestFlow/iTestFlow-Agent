import "server-only";

import { GuardedApiExecutor } from "@/modules/integrations/api-automation/guarded-api-executor";
import {
  ApiExecutorError,
  type ApiExecutionRequest,
  type ApiExecutor,
} from "@/modules/integrations/api-automation/api-executor.port";
import type { BrowserExecutor } from "@/modules/integrations/browser-automation/browser-executor.port";
import { createDatabaseExecutor } from "@/modules/integrations/database-automation/database-executor.factory";
import {
  DatabaseExecutorError,
  type DatabaseExecutionRequest,
  type DatabaseExecutor,
} from "@/modules/integrations/database-automation/database-executor.port";

import type { EnvConfig } from "./run-persistence.service";
import { configuredEnvironmentLayers } from "./environment-layers";
import type { MultiLayerAction } from "./multi-layer-action";
import type { LayerRuntimeObservation, MultiLayerRuntime } from "./multi-layer-runtime.port";

export type TestExecutionLayerRuntimeOptions = {
  workspaceId: string;
  env: EnvConfig;
  browser: BrowserExecutor | null;
  connectionSecrets: ReadonlyMap<string, string>;
  signal: AbortSignal;
  assertApiTarget?: (url: URL, kind: "api" | "oauth") => Promise<void>;
  assertDatabaseTarget?: (input: { host: string; port: number }) => Promise<void>;
  apiFactory?: () => ApiExecutor;
  databaseFactory?: () => DatabaseExecutor;
};

export class TestExecutionLayerRuntime implements MultiLayerRuntime {
  readonly configuredLayers: ReadonlySet<"ui" | "api" | "db">;
  private api: ApiExecutor | null = null;
  private database: DatabaseExecutor | null = null;

  constructor(private readonly options: TestExecutionLayerRuntimeOptions) {
    this.configuredLayers = new Set(configuredEnvironmentLayers(options.env, {
      browserAvailable: Boolean(options.browser),
    }));
  }

  async inspectUi() {
    if (!this.options.browser || !this.options.env.initialUrl) {
      throw new Error("UI is not configured for this environment.");
    }
    return this.options.browser.takeSnapshot();
  }

  async execute(action: MultiLayerAction): Promise<LayerRuntimeObservation> {
    if (action.type === "ui_snapshot") {
      const started = Date.now();
      return { status: "ok", summary: "Current UI inspected.", durationMs: Date.now() - started, uiSnapshot: await this.inspectUi() };
    }
    if (action.type === "ui_action") return this.executeUi(action.action);
    if (action.type === "api_request") {
      return this.executeApi(() => ({
        method: action.arguments.method,
        path: action.arguments.path,
        query: action.arguments.query,
        headers: action.arguments.headers,
      }));
    }
    if (action.type === "api_execute_operation") {
      // Rendering happens inside executeApi's try: a template/parameter error
      // is a normal blocked/failed observation, not a whole-step infra error.
      return this.executeApi(() => renderApiOperation(action.capability.definition, action.arguments.parameters));
    }
    if (action.type === "db_schema") {
      return this.executeDatabase(() => ({ kind: "schema", tablePattern: action.arguments.tablePattern }));
    }
    if (action.type === "db_select") {
      return this.executeDatabase(() => ({ kind: "select", sql: action.arguments.sql, parameters: action.arguments.parameters }));
    }
    return this.executeDatabase(() => ({
      kind: action.capability.safetyClass === "mutation" ? "mutation" : "select",
      sql: requiredString(action.capability.definition, "sql", "Database operation has no SQL template."),
      parameters: action.arguments.parameters,
    }));
  }

  async dispose(): Promise<void> {
    const api = this.api;
    const database = this.database;
    this.api = null;
    this.database = null;
    await Promise.allSettled([api?.dispose(), database?.dispose()]);
  }

  private async executeUi(action: Parameters<BrowserExecutor["performAgentAction"]>[0]): Promise<LayerRuntimeObservation> {
    const browser = this.options.browser;
    if (!browser) return { status: "blocked", category: "prerequisite", code: "ui-not-configured", summary: "UI is not configured.", durationMs: 0 };
    const result = await browser.performAgentAction(action);
    // A navigation/context change can make the immediate post-action snapshot
    // fail. Never substitute stale state: retry once after a short settle,
    // then report the real action result without a snapshot — the agent loop
    // can issue ui_snapshot next iteration.
    let snapshot: Awaited<ReturnType<BrowserExecutor["takeSnapshot"]>> | null = null;
    let snapshotUnavailable = false;
    try {
      snapshot = await browser.takeSnapshot();
    } catch {
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        snapshot = await browser.takeSnapshot();
      } catch {
        snapshotUnavailable = true;
      }
    }
    const unavailableNote = snapshotUnavailable ? " (post-action snapshot unavailable)" : "";
    if (result.status === "ok") {
      return {
        status: "ok",
        summary: `${result.observation.detail ?? `UI ${action.type} completed.`}${unavailableNote}`,
        durationMs: result.observation.durationMs,
        data: { url: result.observation.url ?? snapshot?.url },
        ...(snapshot ? { uiSnapshot: snapshot } : {}),
      };
    }
    return {
      status: result.reason === "policy_violation" ? "blocked" : "failed",
      category: result.reason === "policy_violation" ? "policy" : result.reason === "timeout" ? "timeout" : "action",
      ...(result.reason === "policy_violation" ? { code: "ui-policy-violation" } : {}),
      summary: `${result.observation.detail ?? `UI action failed: ${result.reason}.`}${unavailableNote}`,
      durationMs: result.observation.durationMs,
      ...(snapshot ? { uiSnapshot: snapshot } : {}),
    };
  }

  private async executeApi(buildRequest: () => ApiExecutionRequest): Promise<LayerRuntimeObservation> {
    // Render/definition errors are normal blocked observations the agent can
    // react to — never whole-step infrastructure errors.
    let request: ApiExecutionRequest;
    try {
      request = buildRequest();
    } catch (error) {
      return blockedFromRenderError(error, "invalid-api-operation");
    }
    try {
      const result = await (await this.ensureApi()).execute(request);
      return {
        status: "ok",
        summary: `${request.method} ${request.path} returned HTTP ${result.statusCode}.`,
        durationMs: result.durationMs,
        data: {
          status: result.statusCode,
          statusText: result.statusText,
          headers: result.safeHeaders,
          body: result.safeBody,
          truncated: result.truncated,
          url: result.url,
        },
        apiBody: result.body,
      };
    } catch (error) {
      if (!(error instanceof ApiExecutorError)) throw error;
      if (error.uncertainSideEffect) {
        return { status: "uncertain", category: error.category === "timeout" ? "timeout" : "transport", summary: error.message, durationMs: 0 };
      }
      if (error.category === "policy" || error.category === "prerequisite") {
        return { status: "blocked", category: error.category, code: error.code, summary: error.message, durationMs: 0 };
      }
      return { status: "failed", category: error.category, code: error.code, summary: error.message, durationMs: 0 };
    }
  }

  private async executeDatabase(buildRequest: () => DatabaseExecutionRequest): Promise<LayerRuntimeObservation> {
    let request: DatabaseExecutionRequest;
    try {
      request = buildRequest();
    } catch (error) {
      return blockedFromRenderError(error, "invalid-database-operation");
    }
    try {
      const result = await (await this.ensureDatabase()).execute(request);
      if (result.status === "query_error") {
        // Deliberate: a server-side query error is a normal observation with
        // status "ok" so the agent sees the SQL error text and can adapt its
        // next query. The summary carries the error; it is NOT step evidence
        // of success. Pinned by test — do not "fix" this into a failure.
        return {
          status: "ok",
          summary: `Database returned ${result.sqlState ?? "an error"}: ${result.errorMessage ?? "query failed"}`,
          durationMs: result.durationMs,
          data: { command: result.command, sqlState: result.sqlState, error: result.errorMessage },
        };
      }
      return {
        status: "ok",
        summary: `${result.command} completed with ${result.rowCount} row(s).`,
        durationMs: result.durationMs,
        data: {
          command: result.command,
          rowCount: result.rowCount,
          columns: result.columns,
          rows: result.safeRows,
          truncated: result.truncated,
        },
        dbRows: result.rows,
      };
    } catch (error) {
      if (!(error instanceof DatabaseExecutorError)) throw error;
      if (error.uncertainSideEffect) {
        return { status: "uncertain", category: error.category === "timeout" ? "timeout" : "transport", summary: error.message, durationMs: 0 };
      }
      if (error.category === "policy" || error.category === "prerequisite") {
        return { status: "blocked", category: error.category, code: error.code, summary: error.message, durationMs: 0 };
      }
      return { status: "failed", category: error.category, code: error.code, summary: error.message, durationMs: 0 };
    }
  }

  private async ensureApi() {
    if (this.api) return this.api;
    const config = this.options.env.api;
    if (!config) throw new ApiExecutorError("API is not configured.", "prerequisite");
    this.api = this.options.apiFactory?.() ?? new GuardedApiExecutor({
      workspaceId: this.options.workspaceId,
      baseUrl: config.baseUrl,
      auth: config.auth,
      connectionSecrets: this.options.connectionSecrets,
      requestTimeoutMs: config.requestTimeoutMs,
      signal: this.options.signal,
      assertTarget: this.options.assertApiTarget,
    });
    return this.api;
  }

  private async ensureDatabase() {
    if (this.database) return this.database;
    const config = this.options.env.database;
    if (!config) throw new DatabaseExecutorError("Database is not configured.", "prerequisite");
    await this.options.assertDatabaseTarget?.({ host: config.host, port: config.port });
    const password = this.options.connectionSecrets.get("db.password");
    if (!password) throw new DatabaseExecutorError("Database password is not configured.", "prerequisite");
    this.database = this.options.databaseFactory?.() ?? createDatabaseExecutor({
      ...config,
      workspaceId: this.options.workspaceId,
      password,
      signal: this.options.signal,
    });
    return this.database;
  }
}

function blockedFromRenderError(error: unknown, fallbackCode: string): LayerRuntimeObservation {
  const message = error instanceof Error ? error.message : "The operation request could not be rendered.";
  const category = error instanceof ApiExecutorError && error.category === "policy" ? "policy" as const : "prerequisite" as const;
  const code = error instanceof ApiExecutorError && error.code ? error.code : fallbackCode;
  return { status: "blocked", category, code, summary: message, durationMs: 0 };
}

function renderApiOperation(
  definition: Record<string, unknown>,
  parameters: Record<string, unknown>,
): ApiExecutionRequest {
  const method = requiredString(definition, "method", "API operation has no method.").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new ApiExecutorError(`Unsupported API method "${method}".`, "policy");
  const pathTemplate = requiredString(definition, "path", "API operation has no relative path.");
  const path = pathTemplate.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => encodeURIComponent(String(requiredParameter(parameters, name))));
  return {
    method: method as ApiExecutionRequest["method"],
    path,
    query: renderRecord(definition.query, parameters) as ApiExecutionRequest["query"],
    headers: renderRecord(definition.headers, parameters) as Record<string, string>,
    body: renderTemplate(definition.body, parameters),
    contentType: isContentType(definition.contentType) ? definition.contentType : undefined,
  };
}

function renderRecord(value: unknown, parameters: Record<string, unknown>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rendered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const optionalPlaceholder = typeof entry === "string"
      ? /^\{\{param:([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(entry)
      : null;
    // Optional OpenAPI query parameters are represented by a whole-value
    // placeholder. Omit the query/header entry when the validated parameter
    // object does not contain it; path placeholders remain mandatory.
    if (optionalPlaceholder && !Object.prototype.hasOwnProperty.call(parameters, optionalPlaceholder[1])) {
      continue;
    }
    rendered[key] = renderTemplate(entry, parameters);
  }
  return rendered;
}

function renderTemplate(value: unknown, parameters: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{param:([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(value);
    if (whole) return requiredParameter(parameters, whole[1]);
    return value.replace(/\{\{param:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name: string) => String(requiredParameter(parameters, name)));
  }
  if (Array.isArray(value)) return value.map((entry) => renderTemplate(entry, parameters));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, renderTemplate(entry, parameters)]));
  return value;
}

function requiredParameter(parameters: Record<string, unknown>, name: string) {
  if (!Object.prototype.hasOwnProperty.call(parameters, name)) throw new ApiExecutorError(`API operation parameter "${name}" is missing.`, "policy");
  return parameters[name];
}

function requiredString(definition: Record<string, unknown>, key: string, message: string) {
  const value = definition[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function isContentType(value: unknown): value is NonNullable<ApiExecutionRequest["contentType"]> {
  return value === "application/json" || value === "text/plain" || value === "application/x-www-form-urlencoded";
}
