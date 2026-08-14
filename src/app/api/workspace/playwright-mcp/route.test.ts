import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWorkspaceRequest = vi.fn();
const getSummary = vi.fn();
const saveConfig = vi.fn();
const resolveConfig = vi.fn();
const resolveConfigForUpdate = vi.fn();
const connect = vi.fn();

vi.mock("@/modules/workspace/workspace-request", () => ({
  resolveWorkspaceRequest: (...args: unknown[]) => resolveWorkspaceRequest(...args),
  workspaceRequestError: () => null,
}));
vi.mock("@/modules/test-execution/playwright-mcp-config.service", () => ({
  getPlaywrightMcpConfigSummary: (...args: unknown[]) => getSummary(...args),
  savePlaywrightMcpConfig: (...args: unknown[]) => saveConfig(...args),
  resolvePlaywrightMcpConfig: (...args: unknown[]) => resolveConfig(...args),
  resolvePlaywrightMcpConfigForUpdate: (...args: unknown[]) => resolveConfigForUpdate(...args),
  isAllowedPlaywrightMcpHttpUrl: (value: string) => new URL(value).origin === "https://mcp.example",
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
  resolveConfigForUpdate.mockResolvedValue(null);
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

  it("allows an owner to replace a stored origin after deployment policy revokes it", async () => {
    resolveConfigForUpdate.mockResolvedValue({ bearerToken: "saved-token" });
    const response = await PUT(request({ transport: "http", endpoint: "https://mcp.example/mcp", enabled: true }));
    expect(response.status).toBe(200);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://mcp.example/mcp", bearerToken: "saved-token" }));
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://mcp.example/mcp" }));
  });

  it("does not hide unrelated configuration-store failures", async () => {
    resolveConfigForUpdate.mockRejectedValue(new Error("database unavailable"));
    await expect(PUT(request({ transport: "http", endpoint: "https://mcp.example/mcp", bearerToken: "replacement", enabled: true }))).rejects.toThrow("database unavailable");
    expect(saveConfig).not.toHaveBeenCalled();
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
