import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

import {
  assertAllowedPlaywrightTool,
  createPlaywrightToolPolicy,
  executeTestStepWithAgent,
  mapExecutionOutcomeToAzure,
  normalizeToolArguments,
  validatePlaywrightToolArguments,
} from "./playwright-agent";
import type { LLMProvider } from "@/modules/llm/llm-types";

const httpPolicy = {
  transport: "http" as const,
  allowedNavigationOrigins: new Set(["https://example.com"]),
  uploadRoots: [],
};

describe("Playwright MCP agent guardrails", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("allows bounded browser tools and rejects unsafe or unrelated tools", () => {
    expect(() => assertAllowedPlaywrightTool("browser_navigate")).not.toThrow();
    expect(() => assertAllowedPlaywrightTool("browser_take_screenshot")).not.toThrow();
    expect(() => assertAllowedPlaywrightTool("browser_evaluate")).toThrow("not allowed");
    expect(() => assertAllowedPlaywrightTool("browser_run_code_unsafe")).toThrow("not allowed");
    expect(() => assertAllowedPlaywrightTool("filesystem_read_file")).toThrow("not allowed");
  });

  it("requires a plain JSON object for tool arguments", () => {
    expect(normalizeToolArguments({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
    expect(() => normalizeToolArguments(["not", "an", "object"])).toThrow("JSON object");
    expect(() => normalizeToolArguments(null)).toThrow("JSON object");
  });

  it("builds a fail-closed deployment tool policy", () => {
    vi.stubEnv("PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS", "https://example.com,http://localhost:3000");
    vi.stubEnv("PLAYWRIGHT_EXECUTION_UPLOAD_ROOTS", JSON.stringify([path.resolve("src")]));
    expect(createPlaywrightToolPolicy("stdio")).toEqual({
      transport: "stdio",
      allowedNavigationOrigins: new Set(["https://example.com", "http://localhost:3000"]),
      uploadRoots: [path.resolve("src")],
    });
    vi.stubEnv("PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS", "");
    expect(() => createPlaywrightToolPolicy("http")).toThrow(/at least one/i);
  });

  it.each([
    { url: "file:///etc/passwd" },
    { url: "https://user:secret@example.com/private" },
    { url: "https://example.com", unexpected: true },
  ])("rejects malformed or over-wide navigation arguments %#", async (args) => {
    await expect(validatePlaywrightToolArguments("browser_navigate", args, httpPolicy)).rejects.toThrow();
  });

  it("normalizes an exact-origin navigation target", async () => {
    await expect(validatePlaywrightToolArguments(
      "browser_navigate", { url: "https://example.com/app" }, httpPolicy,
    )).resolves.toEqual({ url: "https://example.com/app" });
  });

  it("allows only canonical stdio fixture files and chooser cancellation", async () => {
    const uploadPolicy = {
      transport: "stdio" as const,
      allowedNavigationOrigins: httpPolicy.allowedNavigationOrigins,
      uploadRoots: [path.resolve("src")],
    };
    const fixture = path.resolve("src/modules/test-execution/playwright-agent.ts");
    await expect(validatePlaywrightToolArguments("browser_file_upload", {}, uploadPolicy)).resolves.toEqual({});
    await expect(validatePlaywrightToolArguments("browser_file_upload", { paths: [fixture] }, uploadPolicy))
      .resolves.toEqual({ paths: [fixture] });
    await expect(validatePlaywrightToolArguments("browser_file_upload", { paths: [fixture, fixture] }, uploadPolicy))
      .rejects.toThrow(/unique/i);
    await expect(validatePlaywrightToolArguments("browser_file_upload", { paths: [fixture] }, httpPolicy))
      .rejects.toThrow(/stdio/i);
  });

  it("uses one path-free rejection for missing and outside-root upload candidates", async () => {
    const uploadPolicy = {
      transport: "stdio" as const,
      allowedNavigationOrigins: httpPolicy.allowedNavigationOrigins,
      uploadRoots: [path.resolve("src")],
    };
    const missing = path.resolve("sensitive-missing-fixture.txt");
    const outside = path.resolve("package.json");
    const missingMessage = await validatePlaywrightToolArguments("browser_file_upload", { paths: [missing] }, uploadPolicy)
      .then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    const outsideMessage = await validatePlaywrightToolArguments("browser_file_upload", { paths: [outside] }, uploadPolicy)
      .then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(missingMessage).toBe(outsideMessage);
    expect(missingMessage).not.toContain(path.basename(missing));
    expect(missingMessage).not.toContain(path.resolve("src"));
  });

  it("redacts fixture paths from model context and persisted tool events", async () => {
    const fixture = path.resolve("src/modules/test-execution/playwright-agent.ts");
    const decisions = [
      { kind: "tool_call", toolName: "browser_file_upload", arguments: { paths: [fixture] }, reason: "Upload fixture" },
      { kind: "complete", outcome: "passed", summary: "Uploaded." },
    ];
    const generateStructuredOutput = vi.fn(async (input: unknown) => {
      void input;
      return { validatedOutput: decisions.shift() };
    });
    const events: unknown[] = [];
    await executeTestStepWithAgent({
      action: "Upload fixture",
      llm: { generateStructuredOutput } as unknown as LLMProvider,
      tools: { callTool: async () => ({ path: fixture, message: `Uploaded ${fixture}` }) },
      signal: new AbortController().signal,
      toolPolicy: {
        transport: "stdio", allowedNavigationOrigins: httpPolicy.allowedNavigationOrigins,
        uploadRoots: [path.resolve("src")],
      },
      onEvent: (event) => { events.push(event); },
    });
    const durable = JSON.stringify(events);
    const secondPrompt = JSON.stringify(generateStructuredOutput.mock.calls[1]?.[0]);
    for (const value of [fixture, path.basename(fixture), path.resolve("src")]) {
      expect(durable).not.toContain(value);
      expect(secondPrompt).not.toContain(value);
    }
  });

  it("replaces path-bearing MCP upload exceptions before they can be persisted", async () => {
    const fixture = path.resolve("src/modules/test-execution/playwright-agent.ts");
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: {
      kind: "tool_call", toolName: "browser_file_upload",
      arguments: { paths: [fixture] }, reason: "Upload fixture",
    } }) } as unknown as LLMProvider;
    const message = await executeTestStepWithAgent({
      action: "Upload fixture", llm,
      tools: { callTool: async () => { throw new Error(`cannot open ${fixture}`); } },
      signal: new AbortController().signal,
      toolPolicy: {
        transport: "stdio", allowedNavigationOrigins: httpPolicy.allowedNavigationOrigins,
        uploadRoots: [path.resolve("src")],
      },
    }).then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(message).toMatch(/upload failed/i);
    expect(message).not.toContain(fixture);
    expect(message).not.toContain(path.basename(fixture));
    expect(message).not.toContain(path.resolve("src"));
  });

  it("rejects navigation outside the deployment target-origin allowlist", async () => {
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: {
      kind: "tool_call", toolName: "browser_navigate",
      arguments: { url: "http://169.254.169.254/latest/meta-data" }, reason: "Inspect metadata",
    } }) } as unknown as LLMProvider;
    const callTool = vi.fn();
    await expect(executeTestStepWithAgent({
      action: "Open the app", llm, tools: { callTool }, signal: new AbortController().signal,
      toolPolicy: { ...httpPolicy, allowedNavigationOrigins: new Set(["https://app.example"]) },
    })).rejects.toThrow(/allowed origin/i);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects file uploads outside the deployment fixture allowlist", async () => {
    const uploadRoot = path.resolve("src");
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: {
      kind: "tool_call", toolName: "browser_file_upload",
      arguments: { paths: [path.resolve("package.json")] }, reason: "Upload a file",
    } }) } as unknown as LLMProvider;
    const callTool = vi.fn();
    await expect(executeTestStepWithAgent({
      action: "Upload the fixture", llm, tools: { callTool }, signal: new AbortController().signal,
      toolPolicy: { transport: "stdio", allowedNavigationOrigins: httpPolicy.allowedNavigationOrigins, uploadRoots: [uploadRoot] },
    })).rejects.toThrow(/allowed fixture/i);
    expect(callTool).not.toHaveBeenCalled();
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
      signal: new AbortController().signal, toolPolicy: httpPolicy,
    });
    expect(calls).toEqual(["browser_navigate"]);
    expect(result).toMatchObject({ outcome: "passed", turns: 2 });
  });

  it("stops with timeout after the configured turn bound", async () => {
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: { kind: "tool_call", toolName: "browser_snapshot", arguments: {}, reason: "Inspect" } }) } as unknown as LLMProvider;
    const result = await executeTestStepWithAgent({ action: "Inspect", llm, tools: { callTool: async () => ({}) }, signal: new AbortController().signal, toolPolicy: httpPolicy, maxTurns: 2 });
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
