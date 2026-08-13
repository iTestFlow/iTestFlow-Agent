import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWorkspaceRequest = vi.fn();
const getSummary = vi.fn();
const saveConfig = vi.fn();
const resolveConfig = vi.fn();
const connect = vi.fn();

vi.mock("@/modules/workspace/workspace-request", () => ({
  resolveWorkspaceRequest: (...args: unknown[]) => resolveWorkspaceRequest(...args),
  workspaceRequestError: () => null,
}));
vi.mock("@/modules/test-execution/playwright-mcp-config.service", () => ({
  getPlaywrightMcpConfigSummary: (...args: unknown[]) => getSummary(...args),
  savePlaywrightMcpConfig: (...args: unknown[]) => saveConfig(...args),
  resolvePlaywrightMcpConfig: (...args: unknown[]) => resolveConfig(...args),
}));
vi.mock("@/modules/test-execution/playwright-mcp-client", () => ({ connectPlaywrightMcp: (...args: unknown[]) => connect(...args) }));

import { GET, PUT } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/workspace/playwright-mcp", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  resolveWorkspaceRequest.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
  getSummary.mockResolvedValue({ status: "not_configured", transport: null, endpoint: null, artifactBaseUrl: null });
  saveConfig.mockResolvedValue({ status: "configured", transport: "http", endpoint: "https://mcp.example/mcp", artifactBaseUrl: null });
  resolveConfig.mockResolvedValue(null);
  connect.mockResolvedValue({ close: vi.fn() });
  process.env.PLAYWRIGHT_MCP_HTTP_ALLOWED_ORIGINS = "https://mcp.example";
});

describe("workspace Playwright MCP configuration", () => {
  it("requires the owner/admin workspace guard for reads", async () => {
    expect((await GET()).status).toBe(200);
    expect(resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
    expect(getSummary).toHaveBeenCalledWith("ws-1");
  });

  it("stores validated HTTP configuration under the resolved workspace", async () => {
    expect((await PUT(request({ transport: "http", endpoint: "https://mcp.example/mcp", bearerToken: "secret", enabled: true }))).status).toBe(200);
    expect(saveConfig).toHaveBeenCalledWith({ workspaceId: "ws-1", userId: "user-1", transport: "http", endpoint: "https://mcp.example/mcp", bearerToken: "secret", enabled: true });
    expect(connect).toHaveBeenCalled();
  });

  it.each(["http://remote.example/mcp", "file:///tmp/mcp"])("rejects unsafe HTTP endpoint %s", async (endpoint) => {
    expect((await PUT(request({ transport: "http", endpoint }))).status).toBe(400);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("rejects UI-supplied stdio commands", async () => {
    expect((await PUT(request({ transport: "stdio", command: "npx", args: ["malware"] }))).status).toBe(400);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
