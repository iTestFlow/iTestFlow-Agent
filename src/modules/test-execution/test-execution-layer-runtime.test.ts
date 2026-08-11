import { describe, expect, it, vi } from "vitest";

import {
  ApiExecutorError,
  type ApiExecutor,
} from "@/modules/integrations/api-automation/api-executor.port";
import { FakeBrowserExecutor } from "@/modules/integrations/browser-automation/fake-browser-executor";
import {
  DatabaseExecutorError,
  type DatabaseExecutor,
} from "@/modules/integrations/database-automation/database-executor.port";

import { TestExecutionLayerRuntime } from "./test-execution-layer-runtime";

const signal = new AbortController().signal;
const baseEnv = {
  initialUrl: "",
  allowedOrigin: "",
  viewportWidth: 1280,
  viewportHeight: 720,
  headless: true,
  defaultTimeoutMs: 10_000,
  navigationTimeoutMs: 30_000,
  evidenceLevel: "on_failure" as const,
  loginPlan: null,
  loginMode: "session" as const,
  loggedInText: "",
  executionNotes: "",
  users: [],
  api: null,
  database: null,
};
const apiConfig = {
  baseUrl: "https://api.test/",
  contract: null,
  auth: { type: "none" as const },
  requestTimeoutMs: 30_000,
  mutationMode: "disabled" as const,
};
const databaseConfig = {
  driver: "postgres" as const,
  host: "db.test",
  port: 5432,
  databaseName: "test",
  username: "qa",
  tlsMode: "require" as const,
  schemas: ["public"],
  accessMode: "read_only" as const,
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
};

describe("TestExecutionLayerRuntime", () => {
  it("creates API lazily and exposes only safe response data", async () => {
    const api: ApiExecutor = {
      execute: vi.fn(async () => ({
        statusCode: 200, statusText: "OK", headers: {}, safeHeaders: {}, body: { token: "raw" }, safeBody: { token: "[REDACTED]" },
        contentType: "application/json", truncated: false, durationMs: 3, url: "https://api.test/orders",
      })),
      dispose: vi.fn(async () => undefined),
    };
    const runtime = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: { ...baseEnv, api: { baseUrl: "https://api.test/", contract: null, auth: { type: "none" }, requestTimeoutMs: 30_000, mutationMode: "disabled" } },
      browser: null, connectionSecrets: new Map(), signal, apiFactory: () => api,
    });
    const result = await runtime.execute({ layer: "api", type: "api_request", arguments: { method: "GET", path: "/orders", query: {}, headers: {}, captures: [] } });
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ body: { token: "[REDACTED]" } });
    expect(result.apiBody).toEqual({ token: "raw" });
  });

  it("compiles approved API templates and database operations", async () => {
    const apiExecute = vi.fn(async () => ({ statusCode: 201, statusText: "Created", headers: {}, safeHeaders: {}, body: {}, safeBody: {}, contentType: "application/json", truncated: false, durationMs: 1, url: "https://api.test/orders/42" }));
    const dbExecute = vi.fn(async () => ({ status: "ok" as const, command: "UPDATE", rowCount: 1, columns: [], rows: [], safeRows: [], truncated: false, durationMs: 2 }));
    const database: DatabaseExecutor = { driver: "postgres", execute: dbExecute, dispose: vi.fn(async () => undefined) };
    const runtime = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: {
        ...baseEnv,
        api: { baseUrl: "https://api.test/", contract: null, auth: { type: "none" }, requestTimeoutMs: 30_000, mutationMode: "approved_catalog" },
        database: { driver: "postgres", host: "db.test", port: 5432, databaseName: "test", username: "qa", tlsMode: "require", schemas: ["public"], accessMode: "cataloged_dml", connectTimeoutMs: 10_000, statementTimeoutMs: 30_000 },
      },
      browser: null,
      connectionSecrets: new Map([["db.password", "pw"]]),
      signal,
      apiFactory: () => ({ execute: apiExecute, dispose: vi.fn(async () => undefined) }),
      databaseFactory: () => database,
    });
    await runtime.execute({
      layer: "api", type: "api_execute_operation",
      capability: { id: "create", name: "create", layer: "api", safetyClass: "mutation", approved: true, parameterSchema: {}, definition: { method: "POST", path: "/orders/{id}", query: { id: "{{param:id}}", filter: "{{param:filter}}" }, body: { id: "{{param:id}}" } } },
      arguments: { operationId: "create", parameters: { id: 42 }, captures: [] },
    });
    expect(apiExecute).toHaveBeenCalledWith(expect.objectContaining({ path: "/orders/42", query: { id: 42 }, body: { id: 42 } }));
    await runtime.execute({
      layer: "db", type: "db_execute_operation",
      capability: { id: "update", name: "update", layer: "db", safetyClass: "mutation", approved: true, driver: "postgres", parameterSchema: {}, definition: { sql: "UPDATE public.orders SET status=:status" } },
      arguments: { operationId: "update", parameters: { status: "ready" }, captures: [] },
    });
    expect(dbExecute).toHaveBeenCalledWith(expect.objectContaining({ kind: "mutation" }));
  });

  it("executes UI actions and maps browser policy failures without hiding the next snapshot", async () => {
    const browser = new FakeBrowserExecutor({
      snapshots: ['- button "Save" [ref=e1]'],
      actionScript: [
        { status: "failed", reason: "policy_violation", observation: { durationMs: 2, detail: "origin blocked" } },
        "ok",
      ],
    });
    await browser.start({
      runId: "run-1",
      initialUrl: "https://app.test/",
      allowedOrigin: "https://app.test",
      viewport: { width: 1280, height: 720 },
      headless: true,
      defaultTimeoutMs: 10_000,
      navigationTimeoutMs: 30_000,
      secrets: new Map(),
      signal,
    });
    const runtime = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: { ...baseEnv, initialUrl: "https://app.test/", allowedOrigin: "https://app.test" },
      browser,
      connectionSecrets: new Map(),
      signal,
    });

    expect(runtime.configuredLayers).toEqual(new Set(["ui"]));
    const blocked = await runtime.execute({
      layer: "ui",
      type: "ui_action",
      action: { type: "click", ref: "e1", elementDescription: "Save" },
    });
    expect(blocked).toMatchObject({ status: "blocked", category: "policy", summary: "origin blocked" });
    expect(blocked.uiSnapshot?.text).toContain("Save");

    const ok = await runtime.execute({ layer: "ui", type: "ui_snapshot" });
    expect(ok).toMatchObject({ status: "ok", summary: "Current UI inspected." });
  });

  it("maps typed API failures while allowing HTTP error responses as observations", async () => {
    const execute = vi
      .fn<ApiExecutor["execute"]>()
      .mockRejectedValueOnce(new ApiExecutorError("redirect denied", "policy"))
      .mockRejectedValueOnce(new ApiExecutorError("write outcome unknown", "transport", true))
      .mockResolvedValueOnce({
        statusCode: 404,
        statusText: "Not Found",
        headers: {},
        safeHeaders: {},
        body: { error: "missing" },
        safeBody: { error: "missing" },
        contentType: "application/json",
        truncated: false,
        durationMs: 4,
        url: "https://api.test/missing",
      });
    const runtime = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: { ...baseEnv, api: apiConfig },
      browser: null,
      connectionSecrets: new Map(),
      signal,
      apiFactory: () => ({ execute, dispose: vi.fn(async () => undefined) }),
    });
    const action = { layer: "api" as const, type: "api_request" as const, arguments: { method: "GET" as const, path: "/missing", query: {}, headers: {}, captures: [] } };

    await expect(runtime.execute(action)).resolves.toMatchObject({ status: "blocked", category: "policy" });
    await expect(runtime.execute(action)).resolves.toMatchObject({ status: "uncertain", category: "transport" });
    await expect(runtime.execute(action)).resolves.toMatchObject({ status: "ok", data: { status: 404 } });
  });

  it("maps query errors as inspectable DB observations and protects raw rows", async () => {
    const execute = vi
      .fn<DatabaseExecutor["execute"]>()
      .mockResolvedValueOnce({
        status: "query_error",
        command: "SELECT",
        rowCount: 0,
        columns: [],
        rows: [],
        safeRows: [],
        truncated: false,
        durationMs: 3,
        sqlState: "23505",
        errorMessage: "constraint failed",
      })
      .mockResolvedValueOnce({
        status: "ok",
        command: "SELECT",
        rowCount: 1,
        columns: ["id", "password"],
        rows: [{ id: 1, password: "raw" }],
        safeRows: [{ id: 1, password: "[REDACTED]" }],
        truncated: false,
        durationMs: 2,
      });
    const runtime = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: { ...baseEnv, database: databaseConfig },
      browser: null,
      connectionSecrets: new Map([["db.password", "pw"]]),
      signal,
      assertDatabaseTarget: vi.fn(async () => undefined),
      databaseFactory: () => ({ driver: "postgres", execute, dispose: vi.fn(async () => undefined) }),
    });

    const action = { layer: "db" as const, type: "db_select" as const, arguments: { sql: "SELECT id FROM public.orders", parameters: {}, captures: [] } };
    await expect(runtime.execute(action)).resolves.toMatchObject({ status: "ok", data: { sqlState: "23505" } });
    const result = await runtime.execute(action);
    expect(result.data).toMatchObject({ rows: [{ id: 1, password: "[REDACTED]" }] });
    expect(result.dbRows).toEqual([{ id: 1, password: "raw" }]);
  });

  it("fails closed for missing targets, credentials, and typed database failures", async () => {
    const noTargets = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: baseEnv,
      browser: null,
      connectionSecrets: new Map(),
      signal,
    });
    await expect(noTargets.inspectUi()).rejects.toThrow("UI is not configured");
    await expect(noTargets.execute({ layer: "api", type: "api_request", arguments: { method: "GET", path: "/", query: {}, headers: {}, captures: [] } }))
      .resolves.toMatchObject({ status: "blocked", category: "prerequisite" });

    const noPassword = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: { ...baseEnv, database: databaseConfig },
      browser: null,
      connectionSecrets: new Map(),
      signal,
      assertDatabaseTarget: vi.fn(async () => undefined),
    });
    await expect(noPassword.execute({ layer: "db", type: "db_schema", arguments: {} }))
      .resolves.toMatchObject({ status: "blocked", category: "prerequisite" });

    const failedDatabase = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: { ...baseEnv, database: databaseConfig },
      browser: null,
      connectionSecrets: new Map([["db.password", "pw"]]),
      signal,
      assertDatabaseTarget: vi.fn(async () => undefined),
      databaseFactory: () => ({
        driver: "postgres",
        execute: vi.fn(async () => { throw new DatabaseExecutorError("timed out", "timeout"); }),
        dispose: vi.fn(async () => undefined),
      }),
    });
    await expect(failedDatabase.execute({ layer: "db", type: "db_schema", arguments: {} }))
      .resolves.toMatchObject({ status: "failed", category: "timeout" });
  });

  it("disposes lazy API and database executors idempotently", async () => {
    const apiDispose = vi.fn(async () => undefined);
    const dbDispose = vi.fn(async () => undefined);
    const runtime = new TestExecutionLayerRuntime({
      workspaceId: "ws-test",
      env: { ...baseEnv, api: apiConfig, database: databaseConfig },
      browser: null,
      connectionSecrets: new Map([["db.password", "pw"]]),
      signal,
      assertDatabaseTarget: vi.fn(async () => undefined),
      apiFactory: () => ({
        execute: vi.fn(async () => ({ statusCode: 200, statusText: "OK", headers: {}, safeHeaders: {}, body: {}, safeBody: {}, contentType: null, truncated: false, durationMs: 1, url: "https://api.test/" })),
        dispose: apiDispose,
      }),
      databaseFactory: () => ({
        driver: "postgres",
        execute: vi.fn(async () => ({ status: "ok" as const, command: "SCHEMA", rowCount: 0, columns: [], rows: [], safeRows: [], truncated: false, durationMs: 1 })),
        dispose: dbDispose,
      }),
    });
    await runtime.execute({ layer: "api", type: "api_request", arguments: { method: "GET", path: "/", query: {}, headers: {}, captures: [] } });
    await runtime.execute({ layer: "db", type: "db_schema", arguments: {} });
    await runtime.dispose();
    await runtime.dispose();
    expect(apiDispose).toHaveBeenCalledTimes(1);
    expect(dbDispose).toHaveBeenCalledTimes(1);
  });
});
