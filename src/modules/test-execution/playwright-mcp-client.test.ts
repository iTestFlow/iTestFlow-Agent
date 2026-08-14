import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportConstructor = vi.fn();
const connect = vi.fn();
const listTools = vi.fn();
const close = vi.fn();
const callTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) { transportConstructor(url, options); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connect;
    listTools = listTools;
    close = close;
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
    callTool.mockResolvedValue({ content: [{ type: "text", text: "### Result\n- 0: (current) [App](https://app.example/)" }] });
  });

  afterEach(() => {
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

  it("lists canonical open-tab URLs without exposing the inspection as an agent result", async () => {
    const connection = await connectPlaywrightMcp({
      status: "configured", transport: "http", endpoint: "https://mcp.example/mcp",
      artifactBaseUrl: null, bearerToken: null,
    });
    expect(connection.tools).toHaveProperty("listOpenTabs");
    await expect((connection.tools as { listOpenTabs(signal: AbortSignal): Promise<string[]> })
      .listOpenTabs(new AbortController().signal))
      .resolves.toEqual(["https://app.example/"]);
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
      .resolves.toEqual(["https://app.example/", "https://docs.example/guide"]);

    callTool.mockResolvedValueOnce({ content: [{ type: "text", text: [
      "### Open tabs",
      "- 0: (current) [App](https://app.example/)",
    ].join("\n") }] });
    await expect(connection.tools.listOpenTabs(new AbortController().signal))
      .resolves.toEqual(["https://app.example/"]);

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
