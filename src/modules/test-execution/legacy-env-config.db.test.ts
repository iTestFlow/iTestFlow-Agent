import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

import { deriveExecutionBoundary, EXECUTION_BOUNDARY_VERSION } from "./execution-boundary";
import { assembleRunDetail } from "./report-assembler";
import { loadRunForExecution } from "./run-persistence.service";
import { loadRunDetailRows } from "./run.service";

/**
 * Historical readability of a legacy-intent frozen run: a row written before
 * the execution-policy simplification carries authorization fields that were
 * removed from the input schemas (mutationMode, accessMode, schemas,
 * tlsMode="disable"). Every read path must still work on it — the frozen-run
 * reader keeps the values, the boundary derives the same targets, and the
 * report renders it without leaking connection metadata.
 */

const workspaceId = uniqueTestId("ws_legacyenv");
const projectId = uniqueTestId("proj_legacyenv");
const userId = uniqueTestId("usr_legacyenv");
const orgUrl = `https://dev.azure.com/${workspaceId}`;
const scope = {
  projectId,
  azureProjectId: projectId,
  azureProjectName: projectId,
  azureOrganizationUrl: orgUrl,
};

/** Written verbatim, exactly as a pre-simplification run creator froze it. */
const LEGACY_ENV_CONFIG = {
  initialUrl: "",
  allowedOrigin: "",
  viewportWidth: 1280,
  viewportHeight: 720,
  headless: true,
  defaultTimeoutMs: 10_000,
  navigationTimeoutMs: 30_000,
  evidenceLevel: "on_failure",
  loginPlan: null,
  loginMode: "session",
  loggedInText: "",
  executionNotes: "Legacy environment notes.",
  users: [],
  api: {
    baseUrl: "https://api.legacy.example/v1",
    contract: null,
    auth: {
      type: "oauth2_client_credentials",
      tokenUrl: "https://auth.legacy.example/oauth/token",
      clientId: "legacy-client",
      scopes: [],
    },
    requestTimeoutMs: 20_000,
    mutationMode: "approved_catalog",
  },
  database: {
    driver: "postgres",
    host: "db.legacy.example",
    port: 5433,
    databaseName: "qa",
    username: "itestflow",
    tlsMode: "disable",
    schemas: ["public"],
    connectTimeoutMs: 10_000,
    statementTimeoutMs: 30_000,
    accessMode: "cataloged_dml",
  },
};

/**
 * Inserted already-terminal: `uq_test_execution_runs_active_project` allows one
 * queued/running run per project, and these cases only read the row.
 */
async function insertLegacyRun(): Promise<string> {
  const runId = uniqueTestId("trun_legacyenv");
  const now = nowIso();
  await sqlRun(
    `INSERT INTO test_execution_runs (
       id, workspace_id, project_id, azure_project_id, env_config_json, status, outcome,
       approved_by, approved_at, started_at, finished_at, created_by, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @projectId, @envConfig::jsonb, 'completed', 'passed',
       @userId, @now, @now, @now, @userId, @now, @now
     )`,
    {
      id: runId,
      workspaceId,
      projectId,
      envConfig: JSON.stringify(LEGACY_ENV_CONFIG),
      userId,
      now,
    },
  );
  await sqlRun(
    `INSERT INTO test_execution_case_runs (
       id, run_id, workspace_id, project_id, azure_project_id, order_index, source_kind,
       title, compiled_plan_json, compile_source, status, outcome, created_at, updated_at
     ) VALUES (
       @id, @runId, @workspaceId, @projectId, @projectId, 0, 'manual',
       'Legacy case', @plan::jsonb, 'natural_text', 'completed', 'passed', @now, @now
     )`,
    {
      id: uniqueTestId("tcr_legacyenv"),
      runId,
      workspaceId,
      projectId,
      plan: JSON.stringify({
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Read the orders table", expectedResult: "Rows returned", layerHint: "db" }],
      }),
      now,
    },
  );
  return runId;
}

describeDb("legacy frozen environment config", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM test_execution_runs WHERE workspace_id = @workspaceId`, { workspaceId });
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("parses a pre-intent-v1 frozen config and keeps its removed authorization fields readable", async () => {
    const runId = await insertLegacyRun();

    const bundle = await loadRunForExecution(runId);

    expect(bundle).not.toBeNull();
    const envConfig = bundle!.run.envConfig;
    // The missing stamp is what makes this a legacy-intent run.
    expect(envConfig.executionPolicyVersion).toBeUndefined();
    expect(envConfig.api?.mutationMode).toBe("approved_catalog");
    expect(envConfig.database?.accessMode).toBe("cataloged_dml");
    expect(envConfig.database?.schemas).toEqual(["public"]);
    expect(envConfig.database?.tlsMode).toBe("disable");
    // Everything the current reader needs is still there too.
    expect(envConfig.api?.baseUrl).toBe("https://api.legacy.example/v1");
    expect(envConfig.runNotes).toBe("");
  });

  it("derives the same execution boundary from a legacy config", async () => {
    const runId = await insertLegacyRun();
    const bundle = await loadRunForExecution(runId);

    expect(deriveExecutionBoundary(bundle!.run.envConfig)).toEqual({
      version: EXECUTION_BOUNDARY_VERSION,
      targets: [
        { kind: "api", protocol: "https", host: "api.legacy.example", port: 443 },
        { kind: "openapi", protocol: "https", host: "api.legacy.example", port: 443 },
        { kind: "oauth", protocol: "https", host: "auth.legacy.example", port: 443 },
        { kind: "database", protocol: "tcp", host: "db.legacy.example", port: 5433 },
      ],
    });
  });

  it("renders a legacy run without leaking the removed authorization metadata", async () => {
    const runId = await insertLegacyRun();
    const rows = await loadRunDetailRows({ workspaceId, scope, runId });

    const detail = assembleRunDetail(rows!);

    expect(detail?.run.id).toBe(runId);
    expect(detail?.cases).toHaveLength(1);
    expect(detail?.cases[0].plan?.steps[0].instruction).toBe("Read the orders table");

    const envConfig = detail!.run.envConfig as Record<string, unknown>;
    // The report allowlist dropped every authorization/connection detail.
    expect(envConfig).not.toHaveProperty("mutationMode");
    expect(envConfig).not.toHaveProperty("accessMode");
    expect(envConfig).not.toHaveProperty("executionNotes");
    expect(envConfig.api).toEqual({
      authType: "oauth2_client_credentials",
      hasContract: false,
      requestTimeoutMs: 20_000,
    });
    expect(envConfig.database).toEqual({
      driver: "postgres",
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 30_000,
    });
    const rendered = JSON.stringify(envConfig);
    for (const leak of ["approved_catalog", "cataloged_dml", "tlsMode", "schemaCount", "schemas", "db.legacy.example", "itestflow"]) {
      expect(rendered).not.toContain(leak);
    }
  });
});
