import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { executeMixedTestStep } from "./mixed-execution-agent";

function model(calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const generateToolCall = vi.fn(async () => ({ toolCall: calls.shift() }));
  return { llm: { generateToolCall } as unknown as LLMProvider, generateToolCall };
}

const base = {
  action: "Read account through API and verify status",
  expectedResult: "HTTP 200",
  aliases: [{ alias: "api", kind: "api" as const, allowWrites: false }],
  captureNames: () => ["account_id"],
  llm: {} as LLMProvider,
  signal: new AbortController().signal,
};

describe("mixed execution agent", () => {
  it("requires external evidence and deterministic assertion before passing an API step", async () => {
    const { llm, generateToolCall } = model([
      { name: "complete_test_step", arguments: { outcome: "passed", summary: "guessed" } },
      { name: "api_request", arguments: { alias: "api", method: "GET", path: "/account" } },
      { name: "complete_test_step", arguments: { outcome: "passed", summary: "guessed again" } },
      { name: "assert_value", arguments: { path: "statusCode", operator: "equals", expected: 200 } },
      { name: "complete_test_step", arguments: { outcome: "passed", summary: "verified" } },
    ]);
    const executeTool = vi.fn(async (name: string) => name === "api_request"
      ? { observation: { statusCode: 200, bodyShape: { type: "object" } }, succeeded: true, external: true }
      : { observation: { passed: true }, succeeded: true, assertionPassed: true });
    const result = await executeMixedTestStep({ ...base, llm, executeTool });
    expect(result).toEqual({ outcome: "passed", summary: "verified", turns: 5 });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(generateToolCall.mock.calls)).not.toContain("secret-value");
  });

  it("permits blocked completion when no external operation can start", async () => {
    const { llm } = model([{ name: "complete_test_step", arguments: { outcome: "blocked", summary: "Alias missing" } }]);
    await expect(executeMixedTestStep({ ...base, llm, executeTool: vi.fn() })).resolves.toMatchObject({ outcome: "blocked", turns: 1 });
  });

  it("fails immediately on a deterministic assertion mismatch", async () => {
    const { llm } = model([
      { name: "api_request", arguments: { alias: "api", method: "GET", path: "/account" } },
      { name: "assert_value", arguments: { path: "statusCode", operator: "equals", expected: 200 } },
    ]);
    const result = await executeMixedTestStep({ ...base, llm, executeTool: async (name) => name === "api_request"
      ? { observation: { statusCode: 500 }, succeeded: false, external: true }
      : { observation: { passed: false }, succeeded: false, assertionPassed: false } });
    expect(result.outcome).toBe("failed");
  });
});
