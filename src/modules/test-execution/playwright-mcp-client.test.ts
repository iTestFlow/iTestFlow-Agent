import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportConstructor = vi.fn();
const connect = vi.fn();
const listTools = vi.fn();
const close = vi.fn();

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
    callTool = vi.fn();
  },
}));

import { connectPlaywrightMcp } from "./playwright-mcp-client";

describe("Playwright MCP HTTP transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    connect.mockResolvedValue(undefined);
    listTools.mockResolvedValue({ tools: [{ name: "browser_navigate" }, { name: "browser_snapshot" }] });
    close.mockResolvedValue(undefined);
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
});
