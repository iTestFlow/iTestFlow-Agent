import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlGet = vi.fn();
const decryptSecret = vi.fn();
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ nowIso: () => "2026-08-14T00:00:00.000Z", sqlGet: (...a: unknown[]) => sqlGet(...a), sqlRun: vi.fn() }));
vi.mock("@/modules/security/encryption.service", () => ({ decryptSecret: (...a: unknown[]) => decryptSecret(...a), encryptSecret: vi.fn() }));

import {
  isAllowedPlaywrightMcpHttpUrl,
  resolvePlaywrightMcpConfig,
  resolvePlaywrightMcpConfigForUpdate,
} from "./playwright-mcp-config.service";

describe("resolved Playwright MCP policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    decryptSecret.mockReturnValue("token");
    sqlGet.mockResolvedValue({ transport: "http", endpoint: "https://mcp.example/mcp", artifact_base_url: "https://mcp.example/artifacts", encrypted_bearer_token: null, bearer_token_iv: null, bearer_token_tag: null, bearer_token_key_version: null, enabled: true });
  });

  it("revokes stored HTTP origins removed from deployment policy", async () => {
    process.env.PLAYWRIGHT_MCP_HTTP_ALLOWED_ORIGINS = "https://other.example";
    await expect(resolvePlaywrightMcpConfig("w")).rejects.toThrow(/allowed/i);
  });

  it("rejects credentials embedded in endpoint and artifact URLs", () => {
    process.env.PLAYWRIGHT_MCP_HTTP_ALLOWED_ORIGINS = "https://mcp.example";
    expect(isAllowedPlaywrightMcpHttpUrl("https://user:secret@mcp.example/mcp")).toBe(false);
    expect(isAllowedPlaywrightMcpHttpUrl("https://token@mcp.example/artifacts")).toBe(false);
  });

  it("decrypts a stored bearer token for owner-initiated configuration repair", async () => {
    sqlGet.mockResolvedValue({
      transport: "http", endpoint: "https://old.example/mcp", artifact_base_url: null,
      encrypted_bearer_token: "ciphertext", bearer_token_iv: "iv", bearer_token_tag: "tag",
      bearer_token_key_version: 2, enabled: true,
    });
    await expect(resolvePlaywrightMcpConfigForUpdate("w")).resolves.toMatchObject({ bearerToken: "token" });
    expect(decryptSecret).toHaveBeenCalledWith({ ciphertext: "ciphertext", iv: "iv", tag: "tag", keyVersion: 2 });
  });
});
