import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const transportConstructor = vi.fn();
const stdioConstructor = vi.fn();
const connect = vi.fn();
const listTools = vi.fn();
const close = vi.fn();
const callTool = vi.fn();
const emitTransportClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) { transportConstructor(url, options); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    onclose?: () => void;
    constructor(params: unknown) { stdioConstructor(params, this); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    private transport?: { onclose?: () => void };
    connect = (transport: { onclose?: () => void }) => {
      this.transport = transport;
      const onclose = transport.onclose;
      transport.onclose = () => onclose?.();
      return connect();
    };
    listTools = listTools;
    close = async () => {
      await close();
      emitTransportClose(this.transport);
    };
    callTool = callTool;
  },
}));

import { connectPlaywrightMcp } from "./playwright-mcp-client";

describe("Playwright MCP HTTP transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    connect.mockResolvedValue(undefined);
    listTools.mockResolvedValue({ tools: [{ name: "browser_navigate" }, { name: "browser_snapshot" }, { name: "browser_tabs" }] });
    close.mockResolvedValue(undefined);
    emitTransportClose.mockImplementation((transport?: { onclose?: () => void }) => transport?.onclose?.());
    callTool.mockResolvedValue({ content: [{ type: "text", text: "### Result\n- 0: (current) [App](https://app.example/)" }] });
  });

  afterEach(async () => {
    await Promise.all(stdioConstructor.mock.calls
      .map((call) => (call[0] as { cwd?: string }).cwd)
      .filter((cwd): cwd is string => Boolean(cwd))
      .map((cwd) => rm(cwd, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("rejects redirects before a Streamable HTTP POST can cross the allowed origin", async () => {
    const connection = await connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    });
    expect(transportConstructor).toHaveBeenCalledWith(
      new URL("https://mcp.example/mcp"),
      expect.objectContaining({ requestInit: expect.objectContaining({ redirect: "error" }) }),
    );
    const options = transportConstructor.mock.calls[0]?.[1] as { fetch: typeof fetch };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await options.fetch(new URL("https://redirect.example/sse"), { method: "GET", redirect: "follow" });
    expect(fetchSpy).toHaveBeenCalledWith(
      new URL("https://redirect.example/sse"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    await connection.close();
  });

  it("requires browser_tabs for browser-state verification", async () => {
    listTools.mockResolvedValue({ tools: [{ name: "browser_navigate" }, { name: "browser_snapshot" }] });
    await expect(connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    })).rejects.toThrow('missing required tool "browser_tabs"');
  });

  it("exposes only advertised allowlisted tool definitions without model-controlled filenames", async () => {
    listTools.mockResolvedValue({
      tools: [
        { name: "browser_navigate", description: "Navigate.", inputSchema: { type: "object", properties: { url: { type: "string" }, filename: { type: "string" } }, required: ["url", "filename"] } },
        { name: "browser_snapshot", description: "Snapshot.", inputSchema: { type: "object", properties: { filename: { type: "string" }, nested: { type: "object", properties: { filename: { type: "string" } } } }, required: ["filename"] } },
        { name: "browser_tabs", description: "Tabs.", inputSchema: { type: "object", properties: {} } },
        { name: "filesystem_read_file", description: "Forbidden.", inputSchema: { type: "object", properties: {} } },
      ],
    });
    const connection = await connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    });
    expect(connection.tools.toolDefinitions).toEqual([
      { name: "browser_navigate", description: "Navigate.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
      { name: "browser_snapshot", description: "Snapshot.", inputSchema: { type: "object", properties: { nested: { type: "object", properties: { filename: { type: "string" } } } }, required: [] } },
      { name: "browser_tabs", description: "Tabs.", inputSchema: { type: "object", properties: {} } },
    ]);
  });

  it("filters model filenames before HTTP transport without claiming remote storage", async () => {
    listTools.mockResolvedValue({ tools: [
      { name: "browser_navigate" }, { name: "browser_snapshot" }, { name: "browser_tabs" },
      { name: "browser_take_screenshot" }, { name: "browser_file_upload" },
    ] });
    const connection = await connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    });

    await connection.tools.callTool("browser_take_screenshot", {
      filename: "../outside.png", nested: { filename: "application-owned" }, target: "body",
    }, new AbortController().signal);
    await connection.tools.callTool("browser_file_upload", { paths: ["C:\\fixtures\\approved.txt"] }, new AbortController().signal);

    expect(stdioConstructor).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenNthCalledWith(1,
      { name: "browser_take_screenshot", arguments: { nested: { filename: "application-owned" }, target: "body" } },
      undefined, expect.any(Object));
    expect(callTool).toHaveBeenNthCalledWith(2,
      { name: "browser_file_upload", arguments: { paths: ["C:\\fixtures\\approved.txt"] } },
      undefined, expect.any(Object));
  });

  it("lists canonical current-tab state without exposing the inspection as an agent result", async () => {
    const connection = await connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    });
    expect(connection.tools).toHaveProperty("listOpenTabs");
    await expect(connection.tools.listOpenTabs(new AbortController().signal))
      .resolves.toEqual([{ url: "https://app.example/", current: true }]);
    expect(callTool).toHaveBeenCalledWith(
      { name: "browser_tabs", arguments: { action: "list" } }, undefined, expect.any(Object),
    );
  });

  it("supports and cross-checks Playwright tab response sections", async () => {
    callTool.mockResolvedValueOnce({ content: [{ type: "text", text: [
      "### Result",
      "- 0: (current) [App](https://app.example/)",
      "- 1: [Docs](https://docs.example/guide)",
      "### Open tabs",
      "- 0: (current) [App](https://app.example/)",
      "- 1: [Docs](https://docs.example/guide)",
    ].join("\n") }] });
    const connection = await connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    });
    await expect(connection.tools.listOpenTabs(new AbortController().signal))
      .resolves.toEqual([
        { url: "https://app.example/", current: true },
        { url: "https://docs.example/guide", current: false },
      ]);

    callTool.mockResolvedValueOnce({ content: [{ type: "text", text: [
      "### Open tabs",
      "- 0: [App](https://app.example/)",
      "- 1: (current) [Docs](https://docs.example/guide)",
    ].join("\n") }] });
    await expect(connection.tools.listOpenTabs(new AbortController().signal))
      .resolves.toEqual([
        { url: "https://app.example/", current: false },
        { url: "https://docs.example/guide", current: true },
      ]);

    callTool.mockResolvedValueOnce({ content: [{ type: "text", text: [
      "### Result",
      "- 0: (current) [App](https://app.example/)",
      "### Open tabs",
      "- 0: (current) [Internal](http://127.0.0.1/admin)",
    ].join("\n") }] });
    await expect(connection.tools.listOpenTabs(new AbortController().signal)).rejects.toThrow(/could not be verified/i);
  });

  it("fails closed on errored or multi-block tab responses", async () => {
    const connection = await connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    });
    callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "### Result\n- 0: (current) [App](https://app.example/)" }],
    });
    await expect(connection.tools.listOpenTabs(new AbortController().signal)).rejects.toThrow(/could not be verified/i);

    callTool.mockResolvedValueOnce({ content: [
      { type: "text", text: "### Result\n- 0: (current) [App](https://app.example/)" },
      { type: "text", text: "### Open tabs\n- 0: (current) [Internal](http://127.0.0.1/admin)" },
    ] });
    await expect(connection.tools.listOpenTabs(new AbortController().signal)).rejects.toThrow(/could not be verified/i);

    callTool.mockResolvedValueOnce({ content: [{ type: "text", text: [
      "### Result",
      "- 0: (current) [Internal](http://127.0.0.1/admin)",
      "### Result",
      "- 0: (current) [App](https://app.example/)",
    ].join("\n") }] });
    await expect(connection.tools.listOpenTabs(new AbortController().signal)).rejects.toThrow(/could not be verified/i);
  });
});

describe("Playwright MCP stdio transport", () => {
  const stdioConfig = { status: "configured" as const, transport: "stdio" as const, endpoint: null, artifactBaseUrl: null, bearerToken: null };

  beforeEach(() => {
    vi.resetAllMocks();
    connect.mockResolvedValue(undefined);
    listTools.mockResolvedValue({ tools: [{ name: "browser_navigate" }, { name: "browser_snapshot" }, { name: "browser_tabs" }] });
    close.mockResolvedValue(undefined);
    emitTransportClose.mockImplementation((transport?: { onclose?: () => void }) => transport?.onclose?.());
    process.env.PLAYWRIGHT_MCP_STDIO_COMMAND = "npx";
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify(["@playwright/mcp@latest"]);
  });

  afterEach(async () => {
    await Promise.all(stdioConstructor.mock.calls
      .map((call) => (call[0] as { cwd?: string }).cwd)
      .filter((cwd): cwd is string => Boolean(cwd))
      .map((cwd) => rm(cwd, { recursive: true, force: true })));
    delete process.env.PLAYWRIGHT_MCP_STDIO_COMMAND;
    delete process.env.PLAYWRIGHT_MCP_STDIO_ARGS;
    delete process.env.PLAYWRIGHT_MCP_NO_SANDBOX;
    delete process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX;
    delete process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX_IN_PRODUCTION;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function spawnedStdio(): { command: string; args: string[]; cwd?: string; env?: Record<string, string> } {
    return stdioConstructor.mock.calls.at(-1)?.[0] as {
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    };
  }

  function spawnedStdioTransport(): { onclose?: () => void } {
    return stdioConstructor.mock.calls.at(-1)?.[1] as { onclose?: () => void };
  }

  function withOutputDir(spawn: ReturnType<typeof spawnedStdio>, args: string[]): string[] {
    return [...args, "--output-dir", spawn.cwd!];
  }

  it("uses a unique task-owned cwd and one app-owned output directory despite deployment output args", async () => {
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify([
      "@playwright/mcp@latest", "--output-dir", "deployment-output", "--output-dir=also-deployment-output",
    ]);
    const first = await connectPlaywrightMcp(stdioConfig);
    const firstSpawn = spawnedStdio();
    const second = await connectPlaywrightMcp(stdioConfig);
    const secondSpawn = spawnedStdio();

    expect(firstSpawn.cwd).toMatch(/itestflow-playwright-mcp-/);
    expect(secondSpawn.cwd).toMatch(/itestflow-playwright-mcp-/);
    expect(secondSpawn.cwd).not.toBe(firstSpawn.cwd);
    for (const spawn of [firstSpawn, secondSpawn]) {
      expect(spawn.args.filter((arg) => arg === "--output-dir" || arg.startsWith("--output-dir="))).toEqual(["--output-dir"]);
      expect(spawn.args.at(spawn.args.indexOf("--output-dir") + 1)).toBe(spawn.cwd);
      expect(spawn.args).not.toContain("deployment-output");
      expect(spawn.args).not.toContain("--output-dir=also-deployment-output");
    }

    await first.close();
    await second.close();
  });

  it("keeps stdio runtime directories until actual transport close after close request and connection failure", async () => {
    emitTransportClose.mockImplementation(() => undefined);
    const connection = await connectPlaywrightMcp(stdioConfig);
    const runtimeDir = spawnedStdio().cwd!;
    expect(existsSync(runtimeDir)).toBe(true);
    const normalClose = connection.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(existsSync(runtimeDir)).toBe(true);
    spawnedStdioTransport().onclose?.();
    await normalClose;
    expect(existsSync(runtimeDir)).toBe(false);

    connect.mockRejectedValueOnce(new Error("connection failed"));
    const failedConnection = connectPlaywrightMcp(stdioConfig);
    const expectedFailure = expect(failedConnection).rejects.toThrow("connection failed");
    await vi.waitFor(() => expect(stdioConstructor).toHaveBeenCalledTimes(2));
    const failedRuntimeDir = spawnedStdio().cwd!;
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(existsSync(failedRuntimeDir)).toBe(true);
    spawnedStdioTransport().onclose?.();
    await expectedFailure;
    expect(existsSync(failedRuntimeDir)).toBe(false);
  });

  it("appends the literal --headless flag for headless runs, defaulting to headless", async () => {
    await connectPlaywrightMcp(stdioConfig, { headless: true });
    expect(spawnedStdio().command).toBe("npx");
    expect(spawnedStdio().args).toEqual(withOutputDir(spawnedStdio(), ["@playwright/mcp@latest", "--headless", "--sandbox"]));

    await connectPlaywrightMcp(stdioConfig);
    expect(spawnedStdio().command).toBe("npx");
    expect(spawnedStdio().args).toEqual(withOutputDir(spawnedStdio(), ["@playwright/mcp@latest", "--headless", "--sandbox"]));
  });

  it("never duplicates --headless when the deployment args already carry it", async () => {
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify(["@playwright/mcp@latest", "--headless"]);
    await connectPlaywrightMcp(stdioConfig, { headless: true });
    expect(spawnedStdio().command).toBe("npx");
    expect(spawnedStdio().args).toEqual(withOutputDir(spawnedStdio(), ["@playwright/mcp@latest", "--headless", "--sandbox"]));
  });

  it("leaves the deployment args untouched for headed runs", async () => {
    await connectPlaywrightMcp(stdioConfig, { headless: false });
    expect(spawnedStdio().command).toBe("npx");
    expect(spawnedStdio().args).toEqual(withOutputDir(spawnedStdio(), ["@playwright/mcp@latest", "--sandbox"]));
  });

  it("normalizes default headed, headless, and default launches to exactly one sandbox", async () => {
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify([
      "@playwright/mcp@latest", "--sandbox", "--sandbox=true", "--sandbox=false", "--sandbox=0", "--no-sandbox", "--no-sandbox=false",
      "--config", "mcp.json", "-c", "other.json", "--config=evil.json", "-c=also.json",
    ]);
    for (const options of [{ headless: false }, { headless: true }, undefined]) {
      await connectPlaywrightMcp(stdioConfig, options);
      const spawn = spawnedStdio();
      expect(spawn.args.filter((arg) => arg === "--sandbox")).toEqual(["--sandbox"]);
      expect(spawn.args.filter((arg) => arg.startsWith("--sandbox=") || arg.startsWith("--no-sandbox"))).toEqual([]);
      expect(spawn.args.filter((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=") || arg.startsWith("-c="))).toEqual([]);
      expect(spawn.args).not.toContain("mcp.json");
      expect(spawn.args).not.toContain("other.json");
      expect(spawn.env).not.toHaveProperty("PLAYWRIGHT_MCP_NO_SANDBOX");
    }
  });

  it("strips the parent no-sandbox environment variable by default", async () => {
    process.env.PLAYWRIGHT_MCP_NO_SANDBOX = "true";
    await connectPlaywrightMcp(stdioConfig, { headless: false });
    expect(spawnedStdio().env).toBeDefined();
    expect(spawnedStdio().env).not.toHaveProperty("PLAYWRIGHT_MCP_NO_SANDBOX");
  });

  it("preserves deliberate development sandbox settings only with exact authorization", async () => {
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify(["@playwright/mcp@latest", "--config", "mcp.json", "--no-sandbox", "--sandbox=false"]);
    process.env.PLAYWRIGHT_MCP_NO_SANDBOX = "true";
    process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX = "true";
    await connectPlaywrightMcp(stdioConfig, { headless: false });
    expect(spawnedStdio().args).toEqual(withOutputDir(spawnedStdio(), ["@playwright/mcp@latest", "--config", "mcp.json", "--no-sandbox", "--sandbox=false"]));
    expect(spawnedStdio().env).toMatchObject({ PLAYWRIGHT_MCP_NO_SANDBOX: "true" });
  });

  it.each([
    ["missing production authorization", "true", undefined],
    ["false production authorization", "true", "false"],
    ["case-variant development authorization", "TRUE", "true"],
    ["case-variant production authorization", "true", "TRUE"],
  ])("fails closed in production with %s", async (_caseName, developmentAuthorization, productionAuthorization) => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX = developmentAuthorization;
    if (productionAuthorization === undefined) delete process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX_IN_PRODUCTION;
    else process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX_IN_PRODUCTION = productionAuthorization;
    process.env.PLAYWRIGHT_MCP_NO_SANDBOX = "true";
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify(["@playwright/mcp@latest", "--no-sandbox", "--sandbox=false"]);
    await connectPlaywrightMcp(stdioConfig, { headless: false });
    expect(spawnedStdio().args).toEqual(withOutputDir(spawnedStdio(), ["@playwright/mcp@latest", "--sandbox"]));
    expect(spawnedStdio().env).not.toHaveProperty("PLAYWRIGHT_MCP_NO_SANDBOX");
  });

  it("preserves deliberate production sandbox settings only when both exact authorizations are set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX = "true";
    process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX_IN_PRODUCTION = "true";
    process.env.PLAYWRIGHT_MCP_NO_SANDBOX = "true";
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify(["@playwright/mcp@latest", "--config", "mcp.json", "--no-sandbox"]);
    await connectPlaywrightMcp(stdioConfig, { headless: false });
    expect(spawnedStdio().args).toEqual(withOutputDir(spawnedStdio(), ["@playwright/mcp@latest", "--config", "mcp.json", "--no-sandbox"]));
    expect(spawnedStdio().env).toMatchObject({ PLAYWRIGHT_MCP_NO_SANDBOX: "true" });
  });

  it("keeps app-owned cwd and output directory under an authorized override", async () => {
    process.env.PLAYWRIGHT_MCP_ALLOW_NO_SANDBOX = "true";
    process.env.PLAYWRIGHT_MCP_STDIO_ARGS = JSON.stringify([
      "@playwright/mcp@latest", "--config", "mcp.json", "--no-sandbox", "--output-dir", "deployment-output", "--output-dir=also-deployment-output",
    ]);
    await connectPlaywrightMcp(stdioConfig, { headless: false });
    const spawn = spawnedStdio();
    expect(spawn.cwd).toMatch(/itestflow-playwright-mcp-/);
    expect(spawn.args).toEqual(withOutputDir(spawn, ["@playwright/mcp@latest", "--config", "mcp.json", "--no-sandbox"]));
    expect(spawn.args.filter((arg) => arg === "--output-dir" || arg.startsWith("--output-dir="))).toEqual(["--output-dir"]);
  });
});
