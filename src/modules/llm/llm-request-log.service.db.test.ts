import { afterAll, afterEach, expect, it } from "vitest";

import { writeLLMRequestLog } from "@/modules/llm/llm-request-log.service";
import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { describeDb, uniqueTestId } from "@/test/db";

const schemaNames: string[] = [];

describeDb("LLM request log (DB-backed)", () => {
  afterEach(async () => {
    await flushBackgroundWrites();
    if (schemaNames.length) {
      await sqlRun(
        `DELETE FROM llm_request_logs WHERE schema_name = ANY(@schemaNames)`,
        { schemaNames: schemaNames.splice(0) },
      );
    }
  });

  afterAll(async () => {
    await resetDatabaseForTests();
  });

  it("persists the provider, prompts, status, duration, and structured payloads", async () => {
    const schemaName = uniqueTestId("schema");
    schemaNames.push(schemaName);

    writeLLMRequestLog({
      provider: "openai",
      model: "gpt-test",
      schemaName,
      action: "test_case_generation",
      promptName: "test-case-design",
      promptVersion: "v2",
      systemPrompt: "System instructions",
      userPrompt: "Generate tests",
      requestBody: { temperature: 0.2 },
      responseBody: { id: "response-1" },
      rawOutput: "{\"testCases\":[]}",
      validatedOutput: { testCases: [] },
      status: "Success",
      durationMs: 321,
    });
    await flushBackgroundWrites();

    const row = await sqlGet<{
      provider: string;
      model_name: string;
      action: string;
      prompt_name: string;
      prompt_version: string;
      request_body_json: string;
      validated_output_json: string;
      status: string;
      duration_ms: number;
    }>(
      `SELECT provider, model_name, action, prompt_name, prompt_version,
              request_body_json, validated_output_json, status, duration_ms
       FROM llm_request_logs WHERE schema_name = @schemaName`,
      { schemaName },
    );

    expect(row).toMatchObject({
      provider: "openai",
      model_name: "gpt-test",
      action: "test_case_generation",
      prompt_name: "test-case-design",
      prompt_version: "v2",
      status: "Success",
      duration_ms: 321,
    });
    expect(JSON.parse(row!.request_body_json)).toEqual({ temperature: 0.2 });
    expect(JSON.parse(row!.validated_output_json)).toEqual({ testCases: [] });
  });

  it("redacts nested credentials before the background write reaches PostgreSQL", async () => {
    const schemaName = uniqueTestId("schema_sensitive");
    schemaNames.push(schemaName);

    writeLLMRequestLog({
      provider: "openai",
      model: "deployment-test",
      schemaName,
      systemPrompt: "System",
      userPrompt: "User",
      requestBody: {
        apiKey: "top-secret",
        nested: { authorization: "Bearer secret", safe: "visible" },
        items: [{ personalAccessToken: "pat-secret", id: 1 }],
      },
      responseBody: { token: "response-secret", result: "ok" },
      status: "Failed",
      errorDetails: "Provider rejected the request.",
      durationMs: 15,
    });
    await flushBackgroundWrites();

    const row = await sqlGet<{
      request_body_json: string;
      response_body_json: string;
    }>(
      `SELECT request_body_json, response_body_json
       FROM llm_request_logs WHERE schema_name = @schemaName`,
      { schemaName },
    );

    expect(JSON.parse(row!.request_body_json)).toEqual({
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "visible" },
      items: [{ personalAccessToken: "[REDACTED]", id: 1 }],
    });
    expect(JSON.parse(row!.response_body_json)).toEqual({
      token: "[REDACTED]",
      result: "ok",
    });
  });

  it("stores a safe marker when a payload cannot be serialized", async () => {
    const schemaName = uniqueTestId("schema_cyclic");
    schemaNames.push(schemaName);
    const cyclic: Record<string, unknown> = { password: "hidden" };
    cyclic.self = cyclic;

    writeLLMRequestLog({
      provider: "openai",
      model: "gpt-test",
      schemaName,
      systemPrompt: "System",
      userPrompt: "User",
      requestBody: cyclic,
      status: "Failed",
      durationMs: 1,
    });
    await flushBackgroundWrites();

    const row = await sqlGet<{ request_body_json: string }>(
      `SELECT request_body_json FROM llm_request_logs WHERE schema_name = @schemaName`,
      { schemaName },
    );
    expect(JSON.parse(row!.request_body_json)).toEqual({ unserializable: true });
  });
});
