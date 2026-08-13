import { describe, expect, it } from "vitest";

import {
  assertAllowedPlaywrightTool,
  executeTestStepWithAgent,
  mapExecutionOutcomeToAzure,
  normalizeToolArguments,
} from "./playwright-agent";
import type { LLMProvider } from "@/modules/llm/llm-types";

describe("Playwright MCP agent guardrails", () => {
  it("allows bounded browser tools and rejects unsafe or unrelated tools", () => {
    expect(() => assertAllowedPlaywrightTool("browser_navigate")).not.toThrow();
    expect(() => assertAllowedPlaywrightTool("browser_take_screenshot")).not.toThrow();
    expect(() => assertAllowedPlaywrightTool("browser_run_code_unsafe")).toThrow("not allowed");
    expect(() => assertAllowedPlaywrightTool("filesystem_read_file")).toThrow("not allowed");
  });

  it("requires a plain JSON object for tool arguments", () => {
    expect(normalizeToolArguments({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
    expect(() => normalizeToolArguments(["not", "an", "object"])).toThrow("JSON object");
    expect(() => normalizeToolArguments(null)).toThrow("JSON object");
  });

  it("executes one advertised tool at a time and completes from observed evidence", async () => {
    const decisions = [
      { kind: "tool_call", toolName: "browser_navigate", arguments: { url: "https://example.com" }, reason: "Open page" },
      { kind: "complete", outcome: "passed", summary: "Expected heading was observed." },
    ];
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: decisions.shift() }) } as unknown as LLMProvider;
    const calls: string[] = [];
    const result = await executeTestStepWithAgent({
      action: "Open the page", expectedResult: "Heading is visible", llm,
      tools: { callTool: async (name) => { calls.push(name); return { heading: "Example" }; } },
      signal: new AbortController().signal,
    });
    expect(calls).toEqual(["browser_navigate"]);
    expect(result).toMatchObject({ outcome: "passed", turns: 2 });
  });

  it("stops with timeout after the configured turn bound", async () => {
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: { kind: "tool_call", toolName: "browser_snapshot", arguments: {}, reason: "Inspect" } }) } as unknown as LLMProvider;
    const result = await executeTestStepWithAgent({ action: "Inspect", llm, tools: { callTool: async () => ({}) }, signal: new AbortController().signal, maxTurns: 2 });
    expect(result).toEqual({ outcome: "timeout", summary: "Step exceeded the 2-turn agent limit.", turns: 2 });
  });
});

describe("Azure outcome mapping", () => {
  it.each([
    ["passed", "Passed"],
    ["failed", "Failed"],
    ["blocked", "Blocked"],
    ["timeout", "Timeout"],
    ["cancelled", "Aborted"],
    ["error", "Error"],
  ] as const)("maps %s to %s", (outcome, azureOutcome) => {
    expect(mapExecutionOutcomeToAzure(outcome)).toBe(azureOutcome);
  });
});
