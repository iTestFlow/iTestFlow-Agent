import { describe, expect, it } from "vitest";

import { assembleRunDetail } from "./report-assembler";

describe("assembleRunDetail", () => {
  it("reports target capabilities without exposing connection metadata or sensitive action fields", () => {
    const detail = assembleRunDetail({
      run: {
        id: "run-1",
        status: "completed",
        outcome: "passed",
        env_config_json: {
          initialUrl: "https://app.example.com/login",
          allowedOrigin: "https://app.example.com",
          viewportWidth: 1280,
          viewportHeight: 720,
          headless: true,
          defaultTimeoutMs: 10_000,
          navigationTimeoutMs: 30_000,
          evidenceLevel: "on_failure",
          loginMode: "session",
          loginPlan: { schemaVersion: "v2-natural", steps: [] },
          executionNotes: "internal credential details",
          users: [{ handle: "admin", username: "private@example.com" }],
          api: {
            baseUrl: "https://private-api.example.com/v1",
            auth: { type: "bearer" },
            contract: null,
            requestTimeoutMs: 30_000,
            mutationMode: "disabled",
          },
          database: {
            driver: "postgres",
            host: "db.private.internal",
            port: 5432,
            databaseName: "customers",
            username: "qa_reader",
            tlsMode: "verify-full",
            schemas: ["public"],
            accessMode: "read_only",
            connectTimeoutMs: 10_000,
            statementTimeoutMs: 30_000,
          },
        },
        summary_json: {},
        plan_schema_version: "v2-natural",
        approved_by: "user-1",
        approved_at: "2026-08-10T00:00:00.000Z",
        created_at: "2026-08-10T00:00:00.000Z",
      },
      approvedByName: "User",
      cases: [
        {
          id: "case-1",
          order_index: 0,
          title: "Mixed case",
          source_kind: "azure_test_case",
          source_snapshot_id: "snapshot-1",
          azure_work_item_id: "azure-case-1",
          compiled_plan_json: {
            schemaVersion: "v2-natural",
            steps: [{ instruction: "Verify customer" }],
          },
          status: "completed",
        },
      ],
      steps: [
        {
          id: "step-1",
          case_run_id: "case-1",
          order_index: 0,
          action_json: { instruction: "Verify customer" },
          status: "completed",
        },
      ],
      actions: [
        {
          id: "action-1",
          step_run_id: "step-1",
          order_index: 0,
          layer: "api",
          action_type: "api.request",
          safety_class: "read",
          request_json: { path: "/customers/42", authorization: "Bearer leaked" },
          observation_json: { status: 200, body: { password: "leaked", id: 42 } },
          status: "completed",
          started_at: "2026-08-10T00:00:01.000Z",
          finished_at: "2026-08-10T00:00:02.000Z",
        },
      ],
      artifacts: [],
      candidates: [],
      job: null,
      cursor: "0",
    });

    expect(detail?.run.envConfig).toMatchObject({
      hasApi: true,
      api: { authType: "bearer" },
      hasDatabase: true,
      database: { driver: "postgres", schemaCount: 1 },
      testUserCount: 1,
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("private-api.example.com");
    expect(serialized).not.toContain("db.private.internal");
    expect(serialized).not.toContain("qa_reader");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("Bearer leaked");
    expect(serialized).not.toContain('"password":"leaked"');
    expect(detail?.cases[0]?.steps[0]?.actions[0]?.observation).toEqual({
      status: 200,
      body: { password: "<redacted>", id: 42 },
    });
    expect(detail?.cases[0]).toMatchObject({
      azureTestCaseId: "azure-case-1",
      plan: {
        schemaVersion: "v2-natural",
        steps: [{
          instruction: "Verify customer",
          expectedResult: "",
          layerHint: "auto",
        }],
      },
    });
  });

  it("degrades invalid legacy compiled plans to null", () => {
    const detail = assembleRunDetail({
      run: {
        id: "run-legacy",
        status: "completed",
        summary_json: {},
        env_config_json: {},
      },
      approvedByName: null,
      cases: [{
        id: "case-legacy",
        order_index: 0,
        title: "Legacy case",
        source_kind: "manual",
        compiled_plan_json: { actions: [{ instruction: "Legacy action" }] },
      }],
      steps: [],
      actions: [],
      artifacts: [],
      candidates: [],
      job: null,
      cursor: "0",
    });

    expect(detail?.cases[0]).toMatchObject({
      azureTestCaseId: null,
      plan: null,
    });
  });
});
