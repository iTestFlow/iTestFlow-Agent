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

  it("rejects browser_tabs navigation outside the deployment target-origin allowlist", async () => {
    await expect(validatePlaywrightToolArguments(
      "browser_tabs", { action: "new", url: "http://127.0.0.1:8080/admin" }, httpPolicy,
    )).rejects.toThrow(/allowed origin/i);
  });

  it("enforces action-specific browser_tabs argument shapes", async () => {
    await expect(validatePlaywrightToolArguments("browser_tabs", { action: "list" }, httpPolicy))
      .resolves.toEqual({ action: "list" });
    await expect(validatePlaywrightToolArguments("browser_tabs", { action: "select" }, httpPolicy)).rejects.toThrow();
    await expect(validatePlaywrightToolArguments("browser_tabs", { action: "close", url: "https://example.com" }, httpPolicy)).rejects.toThrow();
    await expect(validatePlaywrightToolArguments("browser_tabs", { action: "new", url: "https://example.com/app", index: 1 }, httpPolicy)).rejects.toThrow();
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
      tools: {
        callTool: async () => ({ path: fixture, message: `Uploaded ${fixture}` }),
        listOpenTabs: async () => ["about:blank"],
      },
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
      tools: {
        callTool: async () => { throw new Error(`cannot open ${fixture}`); },
        listOpenTabs: async () => ["about:blank"],
      },
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
      action: "Open the app", llm, tools: { callTool, listOpenTabs: async () => ["about:blank"] }, signal: new AbortController().signal,
      toolPolicy: { ...httpPolicy, allowedNavigationOrigins: new Set(["https://app.example"]) },
    })).rejects.toThrow(/allowed origin/i);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects a disallowed initial browser tab before model or tool execution", async () => {
    const generateStructuredOutput = vi.fn(async () => ({ validatedOutput: {
      kind: "complete", outcome: "passed", summary: "Unexpectedly continued.",
    } }));
    const callTool = vi.fn();
    const tools = {
      callTool,
      listOpenTabs: vi.fn(async () => ["http://127.0.0.1:8080/admin"]),
    };
    await expect(executeTestStepWithAgent({
      action: "Inspect the app",
      llm: { generateStructuredOutput } as unknown as LLMProvider,
      tools,
      signal: new AbortController().signal,
      toolPolicy: httpPolicy,
    })).rejects.toThrow(/allowed origin/i);
    expect(generateStructuredOutput).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects a disallowed sibling tab even when the current tab is allowed", async () => {
    const generateStructuredOutput = vi.fn();
    const tools = {
      callTool: vi.fn(),
      listOpenTabs: vi.fn(async () => ["https://example.com/app", "http://127.0.0.1:8080/admin"]),
    };
    await expect(executeTestStepWithAgent({
      action: "Inspect the app",
      llm: { generateStructuredOutput } as unknown as LLMProvider,
      tools,
      signal: new AbortController().signal,
      toolPolicy: httpPolicy,
    })).rejects.toThrow(/allowed origin/i);
    expect(generateStructuredOutput).not.toHaveBeenCalled();
  });

  it("allows an empty fresh browser state", async () => {
    const generateStructuredOutput = vi.fn(async () => ({ validatedOutput: {
      kind: "complete", outcome: "passed", summary: "No browser action required.",
    } }));
    await expect(executeTestStepWithAgent({
      action: "No-op",
      llm: { generateStructuredOutput } as unknown as LLMProvider,
      tools: { callTool: vi.fn(), listOpenTabs: async () => [] },
      signal: new AbortController().signal,
      toolPolicy: httpPolicy,
    })).resolves.toMatchObject({ outcome: "passed" });
  });

  it("discards a tool result when browser navigation escapes through a redirect", async () => {
    const decisions = [
      { kind: "tool_call", toolName: "browser_navigate", arguments: { url: "https://example.com/login" }, reason: "Open login" },
      { kind: "complete", outcome: "passed", summary: "Done." },
    ];
    const generateStructuredOutput = vi.fn(async () => ({ validatedOutput: decisions.shift() }));
    const onEvent = vi.fn();
    const tools = {
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "redirected page contents" }] })),
      listOpenTabs: vi.fn()
        .mockResolvedValueOnce(["about:blank"])
        .mockResolvedValueOnce(["https://example.com/login"])
        .mockResolvedValueOnce(["http://127.0.0.1:8080/admin"]),
    };
    await expect(executeTestStepWithAgent({
      action: "Open the app",
      llm: { generateStructuredOutput } as unknown as LLMProvider,
      tools,
      signal: new AbortController().signal,
      toolPolicy: httpPolicy,
      onEvent,
    })).rejects.toThrow(/allowed origin/i);
    expect(tools.callTool).toHaveBeenCalledTimes(1);
    expect(generateStructuredOutput).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("validates browser state when a navigation commits and then rejects", async () => {
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: {
      kind: "tool_call", toolName: "browser_navigate",
      arguments: { url: "https://example.com/login" }, reason: "Open login",
    } }) } as unknown as LLMProvider;
    const tools = {
      callTool: vi.fn(async () => { throw new Error("navigation timed out after commit"); }),
      listOpenTabs: vi.fn()
        .mockResolvedValueOnce(["about:blank"])
        .mockResolvedValueOnce(["https://example.com/login"])
        .mockResolvedValueOnce(["http://127.0.0.1:8080/admin"]),
    };
    await expect(executeTestStepWithAgent({
      action: "Open the app", llm, tools,
      signal: new AbortController().signal, toolPolicy: httpPolicy,
    })).rejects.toThrow(/allowed origin/i);
    expect(tools.listOpenTabs).toHaveBeenCalledTimes(3);
  });

  it("revalidates browser state immediately before dispatching a tool", async () => {
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: {
      kind: "tool_call", toolName: "browser_click",
      arguments: { ref: "button" }, reason: "Continue",
    } }) } as unknown as LLMProvider;
    const tools = {
      callTool: vi.fn(),
      listOpenTabs: vi.fn()
        .mockResolvedValueOnce(["https://example.com/login"])
        .mockResolvedValueOnce(["http://127.0.0.1:8080/admin"]),
    };
    await expect(executeTestStepWithAgent({
      action: "Continue", llm, tools,
      signal: new AbortController().signal, toolPolicy: httpPolicy,
    })).rejects.toThrow(/allowed origin/i);
    expect(tools.callTool).not.toHaveBeenCalled();
  });

  it("revalidates browser state before accepting completion", async () => {
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: {
      kind: "complete", outcome: "passed", summary: "Done.",
    } }) } as unknown as LLMProvider;
    const tools = {
      callTool: vi.fn(),
      listOpenTabs: vi.fn()
        .mockResolvedValueOnce(["https://example.com/app"])
        .mockResolvedValueOnce(["http://127.0.0.1:8080/admin"]),
    };
    await expect(executeTestStepWithAgent({
      action: "Verify", llm, tools,
      signal: new AbortController().signal, toolPolicy: httpPolicy,
    })).rejects.toThrow(/allowed origin/i);
    expect(tools.callTool).not.toHaveBeenCalled();
  });

  it("rejects file uploads outside the deployment fixture allowlist", async () => {
    const uploadRoot = path.resolve("src");
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: {
      kind: "tool_call", toolName: "browser_file_upload",
      arguments: { paths: [path.resolve("package.json")] }, reason: "Upload a file",
    } }) } as unknown as LLMProvider;
    const callTool = vi.fn();
    await expect(executeTestStepWithAgent({
      action: "Upload the fixture", llm, tools: { callTool, listOpenTabs: async () => ["about:blank"] }, signal: new AbortController().signal,
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
      tools: {
        callTool: async (name) => { calls.push(name); return { heading: "Example" }; },
        listOpenTabs: async () => ["https://example.com"],
      },
      signal: new AbortController().signal, toolPolicy: httpPolicy,
    });
    expect(calls).toEqual(["browser_navigate"]);
    expect(result).toMatchObject({ outcome: "passed", turns: 2 });
  });

  it("stops with timeout after the configured turn bound", async () => {
    const llm = { generateStructuredOutput: async () => ({ validatedOutput: { kind: "tool_call", toolName: "browser_snapshot", arguments: {}, reason: "Inspect" } }) } as unknown as LLMProvider;
    const result = await executeTestStepWithAgent({
      action: "Inspect", llm,
      tools: { callTool: async () => ({}), listOpenTabs: async () => ["https://example.com"] },
      signal: new AbortController().signal, toolPolicy: httpPolicy, maxTurns: 2,
    });
    expect(result).toEqual({ outcome: "timeout", summary: "Step exceeded the 2-turn agent limit.", turns: 2 });
  });

  it("threads base URL, execution notes, and test data into the agent prompt", async () => {
    const generateStructuredOutput = vi.fn(async (input: { system: string; user: string }) => {
      void input;
      return { validatedOutput: { kind: "complete", outcome: "passed", summary: "Done." } };
    });
    await executeTestStepWithAgent({
      action: "Enter the Admin Password and sign in", expectedResult: "The dashboard is visible",
      llm: { generateStructuredOutput } as unknown as LLMProvider,
      tools: { callTool: vi.fn(), listOpenTabs: async () => ["https://example.com/app"] },
      signal: new AbortController().signal, toolPolicy: httpPolicy,
      runContext: {
        baseUrl: "https://example.com/app",
        executionNotes: "Use the staging tenant.",
        testData: [{ title: "Admin Password", value: "S3cret!Value" }],
      },
    });
    const call = generateStructuredOutput.mock.calls[0]![0];
    expect(call.system).toMatch(/title\/value pairs/);
    expect(call.system).toMatch(/never override/);
    const user = JSON.parse(call.user);
    expect(user.baseUrl).toBe("https://example.com/app");
    expect(user.executionNotes).toBe("Use the staging tenant.");
    expect(user.testData).toEqual([{ title: "Admin Password", value: "S3cret!Value" }]);
  });

  it("keeps the prompt free of run-context sections when none is provided", async () => {
    const generateStructuredOutput = vi.fn(async (input: { system: string; user: string }) => {
      void input;
      return { validatedOutput: { kind: "complete", outcome: "passed", summary: "Done." } };
    });
    await executeTestStepWithAgent({
      action: "Open the page",
      llm: { generateStructuredOutput } as unknown as LLMProvider,
      tools: { callTool: vi.fn(), listOpenTabs: async () => ["https://example.com"] },
      signal: new AbortController().signal, toolPolicy: httpPolicy,
    });
    const call = generateStructuredOutput.mock.calls[0]![0];
    expect(call.system).not.toMatch(/title\/value pairs/);
    const user = JSON.parse(call.user);
    expect(user).not.toHaveProperty("baseUrl");
    expect(user).not.toHaveProperty("testData");
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
